const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');
const { runSeed } = require('./seed');
const shopify = require('./shopify');

// Auto-seed on boot if the lanes table is empty (fresh volume / fresh
// deploy). ALSO re-seed whenever lane_plan.json itself has changed since
// the last boot — identified by a content hash stored in the meta table —
// so a real re-slot of the room (new lane_plan.json pushed to prod) takes
// effect automatically on the next deploy instead of silently staying on
// the old layout because "the lanes table wasn't empty."
const lanePlanHash = crypto
  .createHash('sha1')
  .update(fs.readFileSync(path.join(__dirname, 'lane_plan.json'), 'utf8'))
  .digest('hex')
  .slice(0, 12);

const setPlanVersion = db.prepare(`
  INSERT INTO meta (key, value) VALUES ('plan_version', ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

const laneCount = db.prepare('SELECT COUNT(*) AS n FROM lanes').get().n;
const storedVersion = db.prepare(`SELECT value FROM meta WHERE key = 'plan_version'`).get();

if (laneCount === 0) {
  const result = runSeed(db);
  setPlanVersion.run(lanePlanHash);
  console.log('Auto-seeded empty database on boot:', result);
} else if (!storedVersion || storedVersion.value !== lanePlanHash) {
  const result = runSeed(db);
  setPlanVersion.run(lanePlanHash);
  console.log(`Lane plan changed (version ${lanePlanHash}) — re-seeded product placement:`, result);
} else {
  console.log(`DB already has ${laneCount} lanes on current plan version (${lanePlanHash}), skipping re-seed.`);
}

const app = express();
app.use(express.json());

// Blueprint is now the primary landing page — the old Floor Plan/Restock
// tile view (index.html) doesn't reflect the current category-zone layout
// look and isn't linked anywhere anymore. Left on disk (still reachable
// directly at /index.html) rather than deleted, in case the restock
// tracking API underneath it is wanted again later.
app.get('/', (req, res) => res.redirect('/blueprint.html'));

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Products ----------
app.get('/api/products', (req, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY category, name').all());
});

// ---------- Floor plan / lanes ----------
app.get('/api/lanes', (req, res) => {
  const lanes = db.prepare(`
    SELECT
      l.id, l.code, l.section, l.row_num, l.position_num,
      la.product_id, la.crates_current, la.max_stack,
      p.name AS product_name, p.category, p.cap, p.u30,
      p.target_crates, p.target_crates_source,
      EXISTS(SELECT 1 FROM restock_log WHERE restock_log.lane_id = l.id) AS ever_stocked
    FROM lanes l
    LEFT JOIN lane_assignments la ON la.lane_id = l.id
    LEFT JOIN products p ON p.id = la.product_id
    ORDER BY l.section, l.row_num, l.position_num
  `).all();
  res.json(lanes);
});

// ---------- Live crate targets (both fridges read this) ----------
// Simple name -> live target map, sourced from Shopify on-hand inventory
// instead of the old 3.5-day demand forecast. This is what backstock's
// static-generated pages fetch client-side to overlay real numbers on top
// of the last-generated snapshot, and what /api/lanes' target_crates field
// is built from for the main walk-in.
app.get('/api/target-crates', (req, res) => {
  const rows = db.prepare(`
    SELECT name, cap, target_crates, target_crates_source FROM products
    WHERE target_crates IS NOT NULL
  `).all();
  const lastSync = db.prepare(`SELECT value FROM meta WHERE key = 'shopify_last_sync'`).get();
  res.json({
    last_sync: lastSync ? lastSync.value : null,
    products: Object.fromEntries(rows.map((r) => [r.name, { target_crates: r.target_crates, cap: r.cap }])),
  });
});

// ---------- Shopify connection (one-time grant + live inventory sync) ----------
app.get('/shopify/install', (req, res) => {
  if (!shopify.configured()) {
    return res.status(500).send('Missing SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET / SHOPIFY_SHOP env vars.');
  }
  const redirectUri = `${req.protocol}://${req.get('host')}/shopify/callback`;
  res.redirect(shopify.installUrl(redirectUri));
});

app.get('/shopify/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || !shopify.verifyState(state)) {
    return res.status(400).send('Invalid or expired install request -- go back to /shopify/install and try again.');
  }
  try {
    const token = await shopify.exchangeCodeForToken(code);
    shopify.saveToken(db, token);
    const result = await shopify.syncInventory(db);
    res.send(
      `Connected to Shopify. Matched ${result.matched} products on the first sync ` +
      `(${result.unmatchedCount} product names didn't match anything in Shopify -- check spelling). ` +
      `Live crate targets will now refresh automatically. You can close this tab.`
    );
  } catch (err) {
    console.error('Shopify OAuth callback failed:', err);
    res.status(500).send(`Something went wrong connecting to Shopify: ${err.message}`);
  }
});

app.get('/api/shopify/status', (req, res) => {
  const token = shopify.getToken(db);
  const savedAt = db.prepare(`SELECT value FROM meta WHERE key = 'shopify_token_saved_at'`).get();
  const lastSync = db.prepare(`SELECT value FROM meta WHERE key = 'shopify_last_sync'`).get();
  const matched = db.prepare(`SELECT COUNT(*) AS n FROM products WHERE target_crates IS NOT NULL`).get().n;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM products`).get().n;
  res.json({
    connected: Boolean(token),
    connected_at: savedAt ? savedAt.value : null,
    last_sync: lastSync ? lastSync.value : null,
    products_with_live_target: matched,
    products_total: total,
  });
});

// Manual trigger, e.g. right after connecting or for testing -- the periodic
// job below handles normal refresh so nobody needs to remember to call this.
app.post('/api/shopify/sync', async (req, res) => {
  try {
    const result = await shopify.syncInventory(db);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Assign (or clear) a product to a lane. Body: { product_id: number|null, max_stack?: number }
app.put('/api/lanes/:id/assign', (req, res) => {
  const laneId = Number(req.params.id);
  const { product_id, max_stack } = req.body;
  const lane = db.prepare('SELECT * FROM lanes WHERE id = ?').get(laneId);
  if (!lane) return res.status(404).json({ error: 'lane not found' });

  const existing = db.prepare('SELECT * FROM lane_assignments WHERE lane_id = ?').get(laneId);
  if (product_id == null) {
    if (existing) db.prepare('DELETE FROM lane_assignments WHERE lane_id = ?').run(laneId);
    return res.json({ ok: true, cleared: true });
  }

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
  if (!product) return res.status(404).json({ error: 'product not found' });

  if (existing) {
    db.prepare(`
      UPDATE lane_assignments SET product_id = ?, max_stack = COALESCE(?, max_stack), updated_at = CURRENT_TIMESTAMP
      WHERE lane_id = ?
    `).run(product_id, max_stack ?? null, laneId);
  } else {
    db.prepare(`
      INSERT INTO lane_assignments (lane_id, product_id, crates_current, max_stack)
      VALUES (?, ?, 0, COALESCE(?, 5))
    `).run(laneId, product_id, max_stack ?? null);
  }
  res.json({ ok: true });
});

// ---------- Restock ----------
// Add crates to a lane. Body: { crates_added: number }
app.post('/api/lanes/:id/restock', (req, res) => {
  const laneId = Number(req.params.id);
  const { crates_added } = req.body;
  if (!Number.isFinite(crates_added) || crates_added === 0) {
    return res.status(400).json({ error: 'crates_added must be a non-zero number' });
  }
  const assignment = db.prepare('SELECT * FROM lane_assignments WHERE lane_id = ?').get(laneId);
  if (!assignment) return res.status(400).json({ error: 'lane has no product assigned' });

  const newCount = Math.max(0, assignment.crates_current + crates_added);
  db.prepare(`
    UPDATE lane_assignments SET crates_current = ?, updated_at = CURRENT_TIMESTAMP WHERE lane_id = ?
  `).run(newCount, laneId);
  db.prepare(`
    INSERT INTO restock_log (lane_id, product_id, crates_added) VALUES (?, ?, ?)
  `).run(laneId, assignment.product_id, crates_added);

  res.json({ ok: true, crates_current: newCount });
});

// Recent restock activity feed
app.get('/api/restock-log', (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.crates_added, r.ts, l.code AS lane_code, p.name AS product_name
    FROM restock_log r
    JOIN lanes l ON l.id = r.lane_id
    LEFT JOIN products p ON p.id = r.product_id
    ORDER BY r.ts DESC
    LIMIT 100
  `).all();
  res.json(rows);
});

// Lanes running low: fewer crates than max_stack - 1 (i.e. down to the top/reserve crate or below)
app.get('/api/low-stock', (req, res) => {
  const rows = db.prepare(`
    SELECT l.code, l.section, la.crates_current, la.max_stack, p.name AS product_name, p.cap
    FROM lane_assignments la
    JOIN lanes l ON l.id = la.lane_id
    JOIN products p ON p.id = la.product_id
    WHERE la.crates_current <= 1
      AND EXISTS(SELECT 1 FROM restock_log WHERE restock_log.lane_id = l.id)
    ORDER BY la.crates_current ASC, l.section, l.code
  `).all();
  res.json(rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hummus Fit warehouse app running on port ${PORT}`);
});

// ---------- Periodic live inventory refresh ----------
// Every 20 minutes, if we've been granted access, re-pull Shopify on-hand
// inventory and update products.target_crates. Skips silently (with a log
// line) if /shopify/install hasn't been completed yet -- this is not fatal,
// the app just keeps showing whatever crate numbers it last had.
const SYNC_INTERVAL_MS = 20 * 60 * 1000;
async function runScheduledSync() {
  if (!shopify.configured() || !shopify.getToken(db)) return;
  try {
    const result = await shopify.syncInventory(db);
    console.log(`Shopify inventory sync: matched ${result.matched} products, ${result.unmatchedCount} unmatched.`);
  } catch (err) {
    console.error('Scheduled Shopify sync failed:', err.message);
  }
}
setInterval(runScheduledSync, SYNC_INTERVAL_MS);
// Also try once shortly after boot, in case the token was already saved
// from a previous deploy (the volume persists it across redeploys).
setTimeout(runScheduledSync, 15 * 1000);
