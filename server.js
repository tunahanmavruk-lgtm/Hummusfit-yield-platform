const express = require("express");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- Google Sheets mirror ---------------------------------------------
// Optional. If GOOGLE_SHEETS_WEBHOOK_URL is set (an Apps Script Web App,
// see apps_script_code.gs), every cook-log and portion-log entry also gets
// mirrored there as a live backup/report layer. The real database above is
// still the source of truth -- this never blocks or fails a request if the
// webhook is slow, unset, or down.
const SHEETS_WEBHOOK = process.env.GOOGLE_SHEETS_WEBHOOK_URL || "";
function syncToSheets(rows) {
  if (!SHEETS_WEBHOOK || !rows.length) return;
  fetch(SHEETS_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows }),
  }).catch(() => {});
}

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

CREATE TABLE IF NOT EXISTS drafts (
  component_id INTEGER PRIMARY KEY REFERENCES components(id) ON DELETE CASCADE,
  raw_weight_g REAL,
  cooked_weight_g REAL,
  crew_a_g REAL,
  crew_b_g REAL,
  notes TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- One row per real-world cook run for a meal, e.g. "the 4 batches we told
-- the kitchen to make Tuesday morning." target_meal_count is optional --
-- if set, it's what the batch was supposed to yield, and drives the
-- shortage/surplus math below.
CREATE TABLE IF NOT EXISTS cook_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meal_id INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  label TEXT,
  target_meal_count INTEGER,
  status TEXT DEFAULT 'open',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Per-component raw/cooked (or raw/prepared, for garnish-type items) weight
-- actually logged against one specific batch. Separate from cook_logs so
-- historical yield-% averages (used everywhere else) aren't skewed by
-- entering the same batch twice, and so a batch can be edited/corrected.
CREATE TABLE IF NOT EXISTS batch_component_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES cook_batches(id) ON DELETE CASCADE,
  component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  raw_weight_g REAL,
  cooked_weight_g REAL,
  notes TEXT,
  logged_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(batch_id, component_id)
);
`);

// --- migration: add label/nutrition columns to components if missing ------
const existingCols = db.prepare("PRAGMA table_info(components)").all().map((c) => c.name);
const newCols = [
  ["common_name", "TEXT"],
  ["sub_ingredients", "TEXT"], // e.g. "Cucumbers, Vinegar, Salt, Calcium Chloride" for a compound ingredient
  ["allergens", "TEXT"], // comma-separated, e.g. "Milk, Soy"
  ["calories_per_g", "REAL"],
  ["protein_g_per_g", "REAL"],
  ["carbs_g_per_g", "REAL"],
  ["fat_g_per_g", "REAL"],
  ["sodium_mg_per_g", "REAL"],
  ["station", "TEXT"], // which kitchen station preps this component, e.g. "Grill", "Steam Table", "Portioning"
  ["kitchen_produced", "INTEGER DEFAULT 1"], // 0 for things like a purchased sauce the kitchen doesn't cook/prep
];
newCols.forEach(([col, type]) => {
  if (!existingCols.includes(col)) {
    db.exec(`ALTER TABLE components ADD COLUMN ${col} ${type}`);
  }
});

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

function getDraft(componentId) {
  return db.prepare("SELECT * FROM drafts WHERE component_id = ?").get(componentId) || null;
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
    common_name: component.common_name || null,
    sub_ingredients: component.sub_ingredients || null,
    allergens: component.allergens || null,
    calories_per_g: component.calories_per_g,
    protein_g_per_g: component.protein_g_per_g,
    carbs_g_per_g: component.carbs_g_per_g,
    fat_g_per_g: component.fat_g_per_g,
    sodium_mg_per_g: component.sodium_mg_per_g,
    station: component.station || null,
    kitchen_produced: component.kitchen_produced == null ? true : !!component.kitchen_produced,
    draft: getDraft(component.id),
  };
}

// --- Meals CRUD -------------------------------------------------------
app.get("/api/meals", (req, res) => {
  // Real meals sort alphabetically; the "(Blank Meal N)" placeholders (added
  // last, so highest id) are pushed to the bottom instead of burying real
  // meals under a wall of blanks.
  const meals = db
    .prepare(
      `SELECT * FROM meals ORDER BY
         CASE WHEN name LIKE '(Blank Meal%' THEN 1 ELSE 0 END,
         name COLLATE NOCASE`
    )
    .all();
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
  const fields = [
    "target_portion_g",
    "name",
    "common_name",
    "sub_ingredients",
    "allergens",
    "calories_per_g",
    "protein_g_per_g",
    "carbs_g_per_g",
    "fat_g_per_g",
    "sodium_mg_per_g",
    "station",
  ];
  const sets = [];
  const vals = [];
  fields.forEach((f) => {
    if (req.body[f] !== undefined) {
      sets.push(`${f} = ?`);
      vals.push(req.body[f]);
    }
  });
  if (req.body.kitchen_produced !== undefined) {
    sets.push("kitchen_produced = ?");
    vals.push(req.body.kitchen_produced ? 1 : 0);
  }
  if (!sets.length) return res.json({ status: "ok" });
  vals.push(req.params.id);
  db.prepare(`UPDATE components SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  res.json({ status: "ok" });
});

// --- Logging ------------------------------------------------------------
function componentWithMealName(componentId) {
  return db
    .prepare(
      `SELECT components.id, components.name AS component_name, meals.id AS meal_id, meals.name AS meal_name
       FROM components JOIN meals ON meals.id = components.meal_id
       WHERE components.id = ?`
    )
    .get(componentId);
}

app.post("/api/components/:id/cook-log", (req, res) => {
  const { raw_weight_g, cooked_weight_g, notes } = req.body;
  if (!raw_weight_g || !cooked_weight_g)
    return res.status(400).json({ error: "raw_weight_g and cooked_weight_g required" });
  db.prepare(
    "INSERT INTO cook_logs (component_id, raw_weight_g, cooked_weight_g, notes) VALUES (?, ?, ?, ?)"
  ).run(req.params.id, raw_weight_g, cooked_weight_g, notes || null);
  db.prepare(
    "UPDATE drafts SET raw_weight_g = NULL, cooked_weight_g = NULL WHERE component_id = ?"
  ).run(req.params.id);
  const ctx = componentWithMealName(req.params.id);
  if (ctx) {
    syncToSheets([{
      timestamp: new Date().toISOString(),
      meal_id: "M" + String(ctx.meal_id).padStart(3, "0"),
      meal_name: ctx.meal_name,
      component: ctx.component_name,
      raw_weight_g, cooked_weight_g,
      cook_yield_pct: ((cooked_weight_g / raw_weight_g) * 100).toFixed(1),
      crew_a_g: "", crew_b_g: "",
      notes: notes || "",
    }]);
  }
  res.json({ status: "ok", yield_pct: (cooked_weight_g / raw_weight_g) * 100 });
});

app.post("/api/components/:id/portion-log", (req, res) => {
  const { crew, weight_g } = req.body;
  if (!crew || !weight_g)
    return res.status(400).json({ error: "crew and weight_g required" });
  db.prepare(
    "INSERT INTO portion_logs (component_id, crew, weight_g) VALUES (?, ?, ?)"
  ).run(req.params.id, crew, weight_g);
  if (crew === "Crew A") {
    db.prepare("UPDATE drafts SET crew_a_g = NULL WHERE component_id = ?").run(req.params.id);
  } else if (crew === "Crew B") {
    db.prepare("UPDATE drafts SET crew_b_g = NULL WHERE component_id = ?").run(req.params.id);
  }
  const ctx = componentWithMealName(req.params.id);
  if (ctx) {
    syncToSheets([{
      timestamp: new Date().toISOString(),
      meal_id: "M" + String(ctx.meal_id).padStart(3, "0"),
      meal_name: ctx.meal_name,
      component: ctx.component_name,
      raw_weight_g: "", cooked_weight_g: "", cook_yield_pct: "",
      crew_a_g: crew === "Crew A" ? weight_g : "",
      crew_b_g: crew === "Crew B" ? weight_g : "",
      notes: "",
    }]);
  }
  res.json({ status: "ok" });
});

// --- Autosave drafts (fires every 30s from the client) ---------------------
// Saves whatever is currently typed but not yet submitted, so closing the
// tab / losing connection doesn't lose in-progress entries.
app.put("/api/components/:id/draft", (req, res) => {
  const { raw_weight_g, cooked_weight_g, crew_a_g, crew_b_g, notes } = req.body;
  const exists = db.prepare("SELECT 1 FROM drafts WHERE component_id = ?").get(req.params.id);
  if (exists) {
    db.prepare(
      `UPDATE drafts SET raw_weight_g=?, cooked_weight_g=?, crew_a_g=?, crew_b_g=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE component_id=?`
    ).run(
      raw_weight_g ?? null,
      cooked_weight_g ?? null,
      crew_a_g ?? null,
      crew_b_g ?? null,
      notes ?? null,
      req.params.id
    );
  } else {
    db.prepare(
      `INSERT INTO drafts (component_id, raw_weight_g, cooked_weight_g, crew_a_g, crew_b_g, notes) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      req.params.id,
      raw_weight_g ?? null,
      cooked_weight_g ?? null,
      crew_a_g ?? null,
      crew_b_g ?? null,
      notes ?? null
    );
  }
  res.json({ status: "ok" });
});

// --- One-time roster seed ---------------------------------------------
// Idempotent: skips any name that already exists, so it's safe to hit more
// than once (e.g. after adding more meals to the list later).
const SEED_MEALS = [
  "6-Guys Patty Melt","Arnold 2022 Bowl","Baja Chicken Tacos",
  "Baked Herbed Tilapia (1lb Competition Approved)","BBQ Chicken Garlic Parm Potatoes",
  "BBQ Chicken Mac Bowl","BBQ Meltdown","Blueberry French Toast","Breakfast Burrito",
  "Brookfield Chicken Bowl","Broritto Burrito","Buffalo Chicken Meatballs",
  "Buffalo Chicken Quesadilla","Buffalo Crispy Chicken Wrap","Buffalo Mac N Chicken",
  "Cheeseburger Bowl","Chicken Mushroom Pot Stickers","Chicken Stir Fry",
  "Chicken Taco Bowl","Chipotle Chicken (1lb Competition Approved)",
  "Cinnamon Roll Pancakes","Closed on Sunday Crispy Chicken Bowl","Club Wrap",
  "Competition Approved 90/10 Lean Ground Beef (1lb)",
  "Competition Approved Baked Sweet Potato Fries (1lb)",
  "Competition Approved Chicken Kebab (1lb)","Competition Approved Grilled Chicken (1lb)",
  "Competition Approved Grilled Chicken W/ Smokin Poppie Sauce (1lb)",
  "Competition Approved Grilled Flank Steak (1lb)",
  "Competition Approved Lemon Pepper Salmon (1lb)","Competition Approved Oven Baked Cod (1lb)",
  "Competition Approved Sticky Rice (1lb)","Competition Approved White Basmati Rice (1lb)",
  "Crispy Baked Chicken Wrap","Crispy Vegan Wrap","Farfalle & Chicken Alfredo",
  "Fit Ala Vodka With Chicken","Fit-Fil-A","GLORIOUS GAINS Steak Bites & Cilantro Lime Rice",
  "Gluten Free Carbonara Chicken","Grilled Chicken Parmesan Wrap","Grilled Chicken Pesto Wrap",
  "Herb Butter Steak Tips Bowl","Hey Arnold! Burrito","HFit Signature Fold",
  "Honey Garlic Crispy Chicken Tacos","Hot Honey Steak & Mac","Keto Ricotta Meatballs",
  "Lo Mein Teriyaki Steak","Low Carb Keto Cheeseburger Bowl","Meatball Parmesan Wrap",
  "MsWendy Buff Nuggets","Nacho Average Bowl","Nacho Average Vegan Bowl",
  "Philly Cheesesteak Quesadilla","Pineapple Teriyaki Meatballs","Rigatoni & Meatballs",
  "Soho Steak Bowl","Southwest Chicken Bowl","Southwest Chicken Quesadilla",
  "Spicy Buffalo Wrap","Stacked and Jacked","Strawberry Protein French Toast",
  "Strongsville Chicken Ranch Fold","Taco Build Quesadilla","Teriyaki Flank Bowl",
  "Texas Queso Steak Bowl","TexMex Potato Hash","Thai Chili Chicken",
  "The Arches Mac Daddy Wrap","The Clean Bulk Pasta Bowl","Turkey Bacon Cheddar Egg Muffins",
  "Vegan Breakfast Sandwich","Vegan Cheeseburger Bowl","Vegan Chorizo Quesadilla",
  "West Coast Secret Sauce Bowl","Zeus Bowl","Zeus Bowl V2",
  "(Blank Meal 1)","(Blank Meal 2)","(Blank Meal 3)","(Blank Meal 4)","(Blank Meal 5)",
  "(Blank Meal 6)","(Blank Meal 7)","(Blank Meal 8)","(Blank Meal 9)","(Blank Meal 10)",
];

app.get("/api/seed-meals", (req, res) => {
  const insertMeal = db.prepare("INSERT INTO meals (name) VALUES (?)");
  const exists = db.prepare("SELECT 1 FROM meals WHERE name = ?");
  let added = 0, skipped = 0;
  SEED_MEALS.forEach((name) => {
    if (exists.get(name)) { skipped++; return; }
    insertMeal.run(name);
    added++;
  });
  res.json({ status: "ok", added, skipped, total_seed_list: SEED_MEALS.length });
});

// --- USDA-style ingredient statement + nutrition mini-calculator ----------
// NOTE: this is a planning tool, not a certified nutrition analysis.
// Nutrient densities are whatever the user enters per component (g of raw
// ingredient or a spec-sheet value) -- garbage in, garbage out. Before this
// goes on a retail label, run the final formulation through a verified
// nutrition analysis (lab panel or software such as Genesis/ESHA) and
// confirm FDA vs USDA-FSIS jurisdiction for the ingredient statement format.
app.get("/api/meals/:id/label", (req, res) => {
  const meal = db.prepare("SELECT * FROM meals WHERE id = ?").get(req.params.id);
  if (!meal) return res.status(404).json({ error: "meal not found" });
  const components = db
    .prepare("SELECT * FROM components WHERE meal_id = ? ORDER BY sort_order, id")
    .all(meal.id);

  // Descending order by weight in the finished product (target portion weight),
  // which is the FDA/USDA rule for ingredient statement ordering.
  const ordered = [...components].sort(
    (a, b) => (b.target_portion_g || 0) - (a.target_portion_g || 0)
  );

  const missingWeights = ordered.filter((c) => !c.target_portion_g);

  const ingredientParts = ordered.map((c) => {
    const label = c.common_name || c.name;
    if (c.sub_ingredients) {
      return `${label} (${c.sub_ingredients})`;
    }
    return label;
  });
  const ingredientStatement = ingredientParts.join(", ");

  const allergenSet = new Set();
  components.forEach((c) => {
    if (c.allergens) {
      c.allergens.split(",").map((a) => a.trim()).filter(Boolean).forEach((a) => allergenSet.add(a));
    }
  });
  const containsStatement = allergenSet.size ? `Contains: ${[...allergenSet].join(", ")}` : "";

  let servingWeight = 0, calories = 0, protein = 0, carbs = 0, fat = 0, sodium = 0;
  let nutritionComplete = true;
  components.forEach((c) => {
    const w = c.target_portion_g || 0;
    servingWeight += w;
    if (c.calories_per_g == null) nutritionComplete = false;
    calories += w * (c.calories_per_g || 0);
    protein += w * (c.protein_g_per_g || 0);
    carbs += w * (c.carbs_g_per_g || 0);
    fat += w * (c.fat_g_per_g || 0);
    sodium += w * (c.sodium_mg_per_g || 0);
  });

  res.json({
    meal: meal.name,
    ingredient_statement: ingredientStatement,
    contains_statement: containsStatement,
    ingredient_order_warning: missingWeights.length
      ? `${missingWeights.map((c) => c.name).join(", ")} have no locked target portion weight -- ordering may be wrong until they're set.`
      : null,
    nutrition: {
      serving_weight_g: servingWeight,
      calories,
      protein_g: protein,
      carbs_g: carbs,
      fat_g: fat,
      sodium_mg: sodium,
      is_estimate_complete: nutritionComplete,
    },
  });
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

// --- BATCHES --------------------------------------------------------------
// A batch = one real cook run for a meal ("we told the kitchen to make 4
// batches Tuesday"). The kitchen logs raw/cooked (or raw/prepared, for
// garnish) weight per kitchen-made component against that batch. From what
// was actually cooked we compute: how many finished meals this batch
// actually yields (the bottleneck component wins), and -- if a target was
// set -- whether each component came in short or over, and what should
// have been cooked instead, using that component's all-time average yield.

app.get("/api/meals/:id/batches", (req, res) => {
  const batches = db
    .prepare("SELECT * FROM cook_batches WHERE meal_id = ? ORDER BY id DESC")
    .all(req.params.id);
  res.json(batches);
});

app.post("/api/meals/:id/batches", (req, res) => {
  const meal = db.prepare("SELECT * FROM meals WHERE id = ?").get(req.params.id);
  if (!meal) return res.status(404).json({ error: "meal not found" });
  const { label, target_meal_count } = req.body;
  const result = db
    .prepare(
      "INSERT INTO cook_batches (meal_id, label, target_meal_count) VALUES (?, ?, ?)"
    )
    .run(req.params.id, label || null, target_meal_count || null);
  res.json({ id: result.lastInsertRowid });
});

app.patch("/api/batches/:id", (req, res) => {
  const fields = ["label", "target_meal_count", "status"];
  const sets = [];
  const vals = [];
  fields.forEach((f) => {
    if (req.body[f] !== undefined) {
      sets.push(`${f} = ?`);
      vals.push(req.body[f]);
    }
  });
  if (!sets.length) return res.json({ status: "ok" });
  vals.push(req.params.id);
  db.prepare(`UPDATE cook_batches SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  res.json({ status: "ok" });
});

app.delete("/api/batches/:id", (req, res) => {
  db.prepare("DELETE FROM cook_batches WHERE id = ?").run(req.params.id);
  res.json({ status: "ok" });
});

// Log (or correct) one component's raw/cooked weight for this batch.
app.post("/api/batches/:id/log", (req, res) => {
  const batch = db.prepare("SELECT * FROM cook_batches WHERE id = ?").get(req.params.id);
  if (!batch) return res.status(404).json({ error: "batch not found" });
  const { component_id, raw_weight_g, cooked_weight_g, notes } = req.body;
  if (!component_id) return res.status(400).json({ error: "component_id required" });
  db.prepare(
    `INSERT INTO batch_component_logs (batch_id, component_id, raw_weight_g, cooked_weight_g, notes)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(batch_id, component_id) DO UPDATE SET
       raw_weight_g = excluded.raw_weight_g,
       cooked_weight_g = excluded.cooked_weight_g,
       notes = excluded.notes,
       logged_at = CURRENT_TIMESTAMP`
  ).run(req.params.id, component_id, raw_weight_g ?? null, cooked_weight_g ?? null, notes || null);

  // Also feed this into the all-time cook_logs history (unbatched), so the
  // component's average cook-yield% keeps improving from real batch data --
  // but only once both weights are present, and only on first log to avoid
  // double-counting a correction as a second cook.
  if (raw_weight_g && cooked_weight_g) {
    const already = db
      .prepare(
        `SELECT 1 FROM batch_component_logs WHERE batch_id = ? AND component_id = ? AND raw_weight_g IS NOT NULL`
      )
      .get(req.params.id, component_id);
    if (!already) {
      db.prepare(
        "INSERT INTO cook_logs (component_id, raw_weight_g, cooked_weight_g, notes) VALUES (?, ?, ?, ?)"
      ).run(component_id, raw_weight_g, cooked_weight_g, `Batch #${req.params.id}${batch.label ? " (" + batch.label + ")" : ""}`);
    }
  }
  res.json({ status: "ok" });
});

app.get("/api/batches/:id", (req, res) => {
  const batch = db.prepare("SELECT * FROM cook_batches WHERE id = ?").get(req.params.id);
  if (!batch) return res.status(404).json({ error: "batch not found" });
  const meal = db.prepare("SELECT * FROM meals WHERE id = ?").get(batch.meal_id);
  const allComponents = db
    .prepare("SELECT * FROM components WHERE meal_id = ? ORDER BY sort_order, id")
    .all(batch.meal_id)
    .map(componentSummary);
  const logs = db
    .prepare("SELECT * FROM batch_component_logs WHERE batch_id = ?")
    .all(req.params.id);
  const logByComponent = {};
  logs.forEach((l) => (logByComponent[l.component_id] = l));

  const kitchenRows = allComponents
    .filter((c) => c.kitchen_produced)
    .map((c) => {
      const log = logByComponent[c.id] || null;
      const raw = log?.raw_weight_g ?? null;
      const cooked = log?.cooked_weight_g ?? null;
      const yield_pct_this_batch = raw && cooked ? (cooked / raw) * 100 : null;
      const portions_possible =
        cooked != null && c.target_portion_g ? Math.floor(cooked / c.target_portion_g) : null;
      const neededCookedG =
        batch.target_meal_count && c.target_portion_g
          ? c.target_portion_g * batch.target_meal_count
          : null;
      const varianceG = cooked != null && neededCookedG != null ? cooked - neededCookedG : null;
      const status =
        varianceG == null ? null : varianceG < 0 ? "short" : varianceG > 0 ? "surplus" : "on_target";
      const shouldHaveCookedRawG =
        neededCookedG != null && c.avg_cook_yield_pct
          ? neededCookedG / (c.avg_cook_yield_pct / 100)
          : null;
      return {
        component_id: c.id,
        name: c.name,
        station: c.station,
        target_portion_g: c.target_portion_g,
        avg_cook_yield_pct_alltime: c.avg_cook_yield_pct,
        raw_weight_g: raw,
        cooked_weight_g: cooked,
        yield_pct_this_batch,
        portions_possible_from_this_batch: portions_possible,
        needed_cooked_g: neededCookedG,
        variance_g: varianceG,
        status,
        should_have_cooked_raw_g: shouldHaveCookedRawG,
      };
    });

  const nonKitchenRows = allComponents
    .filter((c) => !c.kitchen_produced)
    .map((c) => ({ component_id: c.id, name: c.name, station: c.station }));

  const portionsLogged = kitchenRows
    .map((r) => r.portions_possible_from_this_batch)
    .filter((v) => v != null);
  const achievable_meals_this_batch = portionsLogged.length ? Math.min(...portionsLogged) : null;
  const bottleneck = portionsLogged.length
    ? kitchenRows.find((r) => r.portions_possible_from_this_batch === achievable_meals_this_batch)
    : null;

  res.json({
    batch,
    meal: { id: meal.id, name: meal.name },
    achievable_meals_this_batch,
    bottleneck_component: bottleneck ? bottleneck.name : null,
    kitchen_components: kitchenRows,
    non_kitchen_components: nonKitchenRows,
  });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Hummus Fit Yield Platform running on :${PORT}`));
