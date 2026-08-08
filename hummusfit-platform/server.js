const express = require("express");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- DB setup -----------------------------------------------------------
// Prefer a Railway volume mounted at /data (survives redeploys). Falls back
// to a local file so the app still runs before a volume is attached.
const DATA_DIR = fs.existsSync("/data") ? "/data" : __dirname;
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "hummusfit.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS meals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meal_id INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  target_portion_g REAL,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cook_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  raw_weight_g REAL NOT NULL,
  cooked_weight_g REAL NOT NULL,
  notes TEXT,
  logged_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS portion_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  crew TEXT NOT NULL,
  weight_g REAL NOT NULL,
  logged_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// --- helpers --------------------------------------------------------------
function avgCookYieldPct(componentId) {
  const rows = db
    .prepare(
      "SELECT raw_weight_g, cooked_weight_g FROM cook_logs WHERE component_id = ?"
    )
    .all(componentId);
  if (!rows.length) return null;
  const ratios = rows
    .filter((r) => r.raw_weight_g > 0)
    .map((r) => r.cooked_weight_g / r.raw_weight_g);
  if (!ratios.length) return null;
  return (ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100;
}

function avgPortionByCrew(componentId) {
  const rows = db
    .prepare("SELECT crew, weight_g FROM portion_logs WHERE component_id = ?")
    .all(componentId);
  const byCrew = {};
  rows.forEach((r) => {
    byCrew[r.crew] = byCrew[r.crew] || [];
    byCrew[r.crew].push(r.weight_g);
  });
  const out = {};
  Object.keys(byCrew).forEach((crew) => {
    const arr = byCrew[crew];
    out[crew] = arr.reduce((a, b) => a + b, 0) / arr.length;
  });
  return out;
}

function componentSummary(component) {
  const yieldPct = avgCookYieldPct(component.id);
  const crewAvgs = avgPortionByCrew(component.id);
  const crewVals = Object.values(crewAvgs);
  let gapG = null,
    gapPct = null;
  if (crewVals.length >= 2) {
    const max = Math.max(...crewVals);
    const min = Math.min(...crewVals);
    gapG = max - min;
    const mean = crewVals.reduce((a, b) => a + b, 0) / crewVals.length;
    gapPct = mean ? (gapG / mean) * 100 : null;
  }
  return {
    id: component.id,
    name: component.name,
    target_portion_g: component.target_portion_g,
    avg_cook_yield_pct: yieldPct,
    crew_avgs_g: crewAvgs,
    crew_gap_g: gapG,
    crew_gap_pct: gapPct,
  };
}

// --- Meals CRUD -------------------------------------------------------
app.get("/api/meals", (req, res) => {
  const meals = db.prepare("SELECT * FROM meals ORDER BY id DESC").all();
  const withComponents = meals.map((m) => {
    const components = db
      .prepare(
        "SELECT * FROM components WHERE meal_id = ? ORDER BY sort_order, id"
      )
      .all(m.id)
      .map(componentSummary);
    return { ...m, components };
  });
  res.json(withComponents);
});

app.post("/api/meals", (req, res) => {
  const { name, components } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const insertMeal = db.prepare("INSERT INTO meals (name) VALUES (?)");
  const result = insertMeal.run(name);
  const mealId = result.lastInsertRowid;
  const insertComp = db.prepare(
    "INSERT INTO components (meal_id, name, target_portion_g, sort_order) VALUES (?, ?, ?, ?)"
  );
  (components || []).forEach((c, idx) => {
    insertComp.run(mealId, c.name, c.target_portion_g || null, idx);
  });
  res.json({ id: mealId });
});

app.delete("/api/meals/:id", (req, res) => {
  db.prepare("DELETE FROM meals WHERE id = ?").run(req.params.id);
  res.json({ status: "ok" });
});

app.post("/api/meals/:id/components", (req, res) => {
  const { name, target_portion_g } = req.body;
  const count = db
    .prepare("SELECT COUNT(*) c FROM components WHERE meal_id = ?")
    .get(req.params.id).c;
  const result = db
    .prepare(
      "INSERT INTO components (meal_id, name, target_portion_g, sort_order) VALUES (?, ?, ?, ?)"
    )
    .run(req.params.id, name, target_portion_g || null, count);
  res.json({ id: result.lastInsertRowid });
});

app.patch("/api/components/:id", (req, res) => {
  const { target_portion_g, name } = req.body;
  if (target_portion_g !== undefined) {
    db.prepare("UPDATE components SET target_portion_g = ? WHERE id = ?").run(
      target_portion_g,
      req.params.id
    );
  }
  if (name !== undefined) {
    db.prepare("UPDATE components SET name = ? WHERE id = ?").run(
      name,
      req.params.id
    );
  }
  res.json({ status: "ok" });
});

// --- Logging ------------------------------------------------------------
app.post("/api/components/:id/cook-log", (req, res) => {
  const { raw_weight_g, cooked_weight_g, notes } = req.body;
  if (!raw_weight_g || !cooked_weight_g)
    return res.status(400).json({ error: "raw_weight_g and cooked_weight_g required" });
  db.prepare(
    "INSERT INTO cook_logs (component_id, raw_weight_g, cooked_weight_g, notes) VALUES (?, ?, ?, ?)"
  ).run(req.params.id, raw_weight_g, cooked_weight_g, notes || null);
  res.json({ status: "ok", yield_pct: (cooked_weight_g / raw_weight_g) * 100 });
});

app.post("/api/components/:id/portion-log", (req, res) => {
  const { crew, weight_g } = req.body;
  if (!crew || !weight_g)
    return res.status(400).json({ error: "crew and weight_g required" });
  db.prepare(
    "INSERT INTO portion_logs (component_id, crew, weight_g) VALUES (?, ?, ?)"
  ).run(req.params.id, crew, weight_g);
  res.json({ status: "ok" });
});

// --- THE CALCULATOR -------------------------------------------------------
// Mode A: "I want N finished meals" -> raw weight to cook, per component.
// Mode B: "I have X g raw of component Y" -> max meals that component supports,
//         then the raw needed for every other component to match that count.
app.post("/api/meals/:id/calculate", (req, res) => {
  const meal = db.prepare("SELECT * FROM meals WHERE id = ?").get(req.params.id);
  if (!meal) return res.status(404).json({ error: "meal not found" });
  const components = db
    .prepare("SELECT * FROM components WHERE meal_id = ? ORDER BY sort_order, id")
    .all(meal.id)
    .map(componentSummary);

  const missing = components.filter(
    (c) => c.avg_cook_yield_pct == null || !c.target_portion_g
  );

  function rawNeededFor(targetMeals) {
    return components.map((c) => {
      const cookedNeeded = c.target_portion_g * targetMeals;
      const rawNeeded =
        c.avg_cook_yield_pct != null
          ? cookedNeeded / (c.avg_cook_yield_pct / 100)
          : null;
      return {
        component: c.name,
        target_portion_g: c.target_portion_g,
        avg_cook_yield_pct: c.avg_cook_yield_pct,
        cooked_weight_needed_g: cookedNeeded,
        raw_weight_to_cook_g: rawNeeded,
      };
    });
  }

  let result;
  if (req.body.mode === "forMeals") {
    const targetMeals = Number(req.body.targetMeals);
    if (!targetMeals || targetMeals <= 0)
      return res.status(400).json({ error: "targetMeals must be > 0" });
    result = {
      mode: "forMeals",
      target_meals: targetMeals,
      components: rawNeededFor(targetMeals),
    };
  } else if (req.body.mode === "fromRaw") {
    const { componentName, rawWeightAvailable } = req.body;
    const comp = components.find(
      (c) => c.name.toLowerCase() === String(componentName || "").toLowerCase()
    );
    if (!comp) return res.status(400).json({ error: "component not found on this meal" });
    if (comp.avg_cook_yield_pct == null || !comp.target_portion_g)
      return res.status(400).json({
        error: `${comp.name} is missing cook-yield data or a locked target portion weight`,
      });
    const cookedAvailable =
      rawWeightAvailable * (comp.avg_cook_yield_pct / 100);
    const mealsPossible = Math.floor(cookedAvailable / comp.target_portion_g);
    result = {
      mode: "fromRaw",
      based_on_component: comp.name,
      raw_weight_available_g: rawWeightAvailable,
      cooked_weight_available_g: cookedAvailable,
      max_meals_possible: mealsPossible,
      components: rawNeededFor(mealsPossible),
    };
  } else {
    return res.status(400).json({ error: "mode must be 'forMeals' or 'fromRaw'" });
  }

  res.json({
    meal: meal.name,
    warnings: missing.length
      ? missing.map(
          (c) =>
            `${c.name}: ${
              c.avg_cook_yield_pct == null ? "no cook-yield log yet" : ""
            } ${c.target_portion_g ? "" : "no target portion weight locked"}`.trim()
        )
      : [],
    ...result,
  });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Hummus Fit Yield Platform running on :${PORT}`));
