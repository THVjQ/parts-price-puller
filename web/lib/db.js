/**
 * SQLite store. Lives on the data volume — git never touches it.
 *
 * prices is append-only history; the matrix reads the newest row per
 * (device, part, grade, source) and the one before it (for the up/down colouring
 * the old sheet did with red/green cell backgrounds).
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || '/app/data';
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'prices.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS prices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device        TEXT NOT NULL,
  part          TEXT NOT NULL,
  grade         TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL,
  price         REAL,                      -- NULL = searched, found nothing
  url           TEXT DEFAULT '',
  matched_title TEXT DEFAULT '',
  ts            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prices_cell ON prices (device, part, grade, source, id DESC);
CREATE INDEX IF NOT EXISTS idx_prices_ts   ON prices (ts);

CREATE TABLE IF NOT EXISTS pins (
  device     TEXT NOT NULL,
  part       TEXT NOT NULL,
  grade      TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'CP',
  product_id TEXT DEFAULT '',
  variant_id TEXT DEFAULT '',
  title      TEXT DEFAULT '',
  url        TEXT DEFAULT '',
  price      REAL,
  ts         TEXT NOT NULL,
  PRIMARY KEY (device, part, grade, source)
);

CREATE TABLE IF NOT EXISTS stores (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  calculator_json TEXT NOT NULL,
  seeded_json     TEXT NOT NULL DEFAULT '{}',   -- last git seed, for "reset to defaults"
  edited          INTEGER NOT NULL DEFAULT 0,   -- 1 = a human saved it; git stops updating it
  updated_at      TEXT NOT NULL
);

-- UI preferences, server-side on purpose: there is one shared login, so the store /
-- grade / view you picked should follow you onto any other device.
CREATE TABLE IF NOT EXISTS prefs (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A retail price a human pinned for ONE store (retail depends on the store's calculator,
-- so unlike a manual wholesale price this is per store). Wins over the calculated retail.
CREATE TABLE IF NOT EXISTS manual_retail (
  store   TEXT NOT NULL,
  device  TEXT NOT NULL,
  part    TEXT NOT NULL,
  grade   TEXT NOT NULL DEFAULT '',
  price   REAL NOT NULL,
  ts      TEXT NOT NULL,
  PRIMARY KEY (store, device, part, grade)
);

-- Devices added from the website's Edit menu. Merged with the git-defined devices at
-- read time, so they survive a git pull and never need a YAML edit.
CREATE TABLE IF NOT EXISTS custom_devices (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL UNIQUE,
  search   TEXT NOT NULL DEFAULT '',
  grp      TEXT NOT NULL DEFAULT 'other',
  aliases  TEXT NOT NULL DEFAULT '',
  enabled  INTEGER NOT NULL DEFAULT 1,
  ts       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  origin  TEXT DEFAULT '',                 -- tm | willard | web | system
  source  TEXT DEFAULT '',                 -- CP | TPH | ''
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_id ON logs (id DESC);

-- Cross-store cell flags: compat issues, micro-soldering, warnings.
-- Keyed by device+part (no grade, no store) so one flag applies everywhere.
CREATE TABLE IF NOT EXISTS cell_flags (
  device  TEXT NOT NULL,
  part    TEXT NOT NULL,
  flag    TEXT NOT NULL,
  note    TEXT NOT NULL DEFAULT '',
  ts      TEXT NOT NULL,
  PRIMARY KEY (device, part, flag)
);
CREATE INDEX IF NOT EXISTS idx_flags_dp ON cell_flags (device, part);
`);

const nowIso = () => new Date().toISOString();

// ─────────────────────────────────────────────────────────────── prices
const insertPrice = db.prepare(`
  INSERT INTO prices (device, part, grade, source, price, url, matched_title, ts)
  VALUES (@device, @part, @grade, @source, @price, @url, @matched_title, @ts)
`);

const insertPrices = db.transaction(rows => {
  for (const r of rows) insertPrice.run(r);
  return rows.length;
});

/**
 * Latest two rows per (device, part, grade, source), restricted to the selected
 * grade plus ungraded ('') rows. `rn` 1 = current, 2 = previous.
 */
const latestStmt = db.prepare(`
  WITH ranked AS (
    SELECT device, part, grade, source, price, url, matched_title, ts,
           ROW_NUMBER() OVER (PARTITION BY device, part, grade, source ORDER BY id DESC) AS rn
    FROM prices
    WHERE grade = @grade OR grade = ''
  )
  SELECT * FROM ranked WHERE rn <= 2
`);

function latestByCell(grade) {
  const out = new Map();   // "device|part|source" → {price,...,prev}
  for (const r of latestStmt.all({ grade })) {
    const k = `${r.device}|${r.part}|${r.source}`;
    const e = out.get(k) || {};
    if (r.rn === 1) Object.assign(e, r); else e.prev = r.price;
    out.set(k, e);
  }
  return out;
}

// The price each cell/source was at, as of a cutoff (used for the 4-week trend colour):
// the newest row that is NOT newer than the cutoff.
const asOfStmt = db.prepare(`
  WITH ranked AS (
    SELECT device, part, grade, source, price,
           ROW_NUMBER() OVER (PARTITION BY device, part, grade, source ORDER BY id DESC) AS rn
    FROM prices
    WHERE (grade = @grade OR grade = '') AND ts <= @cutoff AND price IS NOT NULL
  )
  SELECT device, part, grade, source, price FROM ranked WHERE rn = 1
`);
function priceAsOf(grade, cutoffISO) {
  const out = new Map();   // "device|part|source" → price
  for (const r of asOfStmt.all({ grade, cutoff: cutoffISO })) {
    out.set(`${r.device}|${r.part}|${r.source}`, r.price);
  }
  return out;
}

const lastUpdatedStmt = db.prepare(`SELECT MAX(ts) AS ts FROM prices`);
const priceCountStmt = db.prepare(`SELECT COUNT(*) AS n FROM prices`);

const historyStmt = db.prepare(`
  SELECT price, source, matched_title, url, ts FROM prices
  WHERE device = ? AND part = ? AND (grade = ? OR grade = '')
  ORDER BY id DESC LIMIT 40
`);

const pruneStmt = db.prepare(`DELETE FROM prices WHERE ts < ?`);
function prunePrices(days) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return pruneStmt.run(cutoff).changes;
}

// ─────────────────────────────────────────────────────────────── pins
const upsertPinStmt = db.prepare(`
  INSERT INTO pins (device, part, grade, source, product_id, variant_id, title, url, price, ts)
  VALUES (@device, @part, @grade, @source, @product_id, @variant_id, @title, @url, @price, @ts)
  ON CONFLICT (device, part, grade, source) DO UPDATE SET
    product_id = excluded.product_id, variant_id = excluded.variant_id,
    title = excluded.title, url = excluded.url, price = excluded.price, ts = excluded.ts
`);
const listPinsStmt   = db.prepare(`SELECT * FROM pins ORDER BY device, part`);
const deletePinStmt  = db.prepare(`DELETE FROM pins WHERE device = ? AND part = ? AND grade = ? AND source = ?`);

// ─────────────────────────────────────────────────────────────── stores
const getStoreStmt   = db.prepare(`SELECT * FROM stores WHERE id = ?`);
const listStoresStmt = db.prepare(`SELECT * FROM stores ORDER BY name`);
const insertStoreStmt = db.prepare(`
  INSERT INTO stores (id, name, calculator_json, seeded_json, edited, updated_at)
  VALUES (@id, @name, @calculator_json, @seeded_json, 0, @updated_at)
`);
// Git can freshen the seed + name at any time, but only overwrites the live
// calculator while nobody has edited it in the UI. That is the "git pull must never
// clobber a store's pricing" rule, enforced in one place.
const reseedStoreStmt = db.prepare(`
  UPDATE stores SET name = @name, seeded_json = @seeded_json,
    calculator_json = CASE WHEN edited = 1 THEN calculator_json ELSE @seeded_json END,
    updated_at = @updated_at
  WHERE id = @id
`);
const saveCalcStmt = db.prepare(`
  UPDATE stores SET calculator_json = ?, edited = 1, updated_at = ? WHERE id = ?
`);
const resetCalcStmt = db.prepare(`
  UPDATE stores SET calculator_json = seeded_json, edited = 0, updated_at = ? WHERE id = ?
`);

const seedStores = db.transaction(seeds => {
  for (const s of seeds) {
    const json = JSON.stringify(s.calculator);
    const row = getStoreStmt.get(s.id);
    if (!row) {
      insertStoreStmt.run({ id: s.id, name: s.name, calculator_json: json, seeded_json: json, updated_at: nowIso() });
    } else {
      reseedStoreStmt.run({ id: s.id, name: s.name, seeded_json: json, updated_at: nowIso() });
    }
  }
});

// ─────────────────────────────────────────────────────────────── prefs
const getPrefStmt = db.prepare(`SELECT v FROM prefs WHERE k = ?`);
const setPrefStmt = db.prepare(`
  INSERT INTO prefs (k, v, updated_at) VALUES (?, ?, ?)
  ON CONFLICT (k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at
`);

// ─────────────────────────────────────────────────────────── manual retail
const setManualRetailStmt = db.prepare(`
  INSERT INTO manual_retail (store, device, part, grade, price, ts)
  VALUES (@store, @device, @part, @grade, @price, @ts)
  ON CONFLICT (store, device, part, grade) DO UPDATE SET price = excluded.price, ts = excluded.ts
`);
const clearManualRetailStmt = db.prepare(`DELETE FROM manual_retail WHERE store=? AND device=? AND part=? AND grade=?`);
const listManualRetailStmt = db.prepare(`SELECT * FROM manual_retail WHERE store = ?`);

// ─────────────────────────────────────────────────────── custom devices
const addCustomDeviceStmt = db.prepare(`
  INSERT INTO custom_devices (name, search, grp, aliases, enabled, ts)
  VALUES (@name, @search, @grp, @aliases, 1, @ts)
  ON CONFLICT (name) DO UPDATE SET search=excluded.search, grp=excluded.grp, aliases=excluded.aliases, enabled=1
`);
const listCustomDevicesStmt = db.prepare(`SELECT * FROM custom_devices ORDER BY id`);
const deleteCustomDeviceStmt = db.prepare(`DELETE FROM custom_devices WHERE id = ?`);
const setCustomDeviceEnabledStmt = db.prepare(`UPDATE custom_devices SET enabled = ? WHERE id = ?`);

// ─────────────────────────────────────────────────────────── cell flags
const setFlagStmt = db.prepare(`
  INSERT INTO cell_flags (device, part, flag, note, ts)
  VALUES (@device, @part, @flag, @note, @ts)
  ON CONFLICT (device, part, flag) DO UPDATE SET note=excluded.note, ts=excluded.ts
`);
const clearFlagStmt  = db.prepare(`DELETE FROM cell_flags WHERE device=? AND part=? AND flag=?`);
const listFlagsStmt  = db.prepare(`SELECT device, part, flag, note FROM cell_flags ORDER BY device, part, flag`);

// ─────────────────────────────────────────────────────────────── logs
const insertLogStmt = db.prepare(`INSERT INTO logs (ts, origin, source, message) VALUES (?, ?, ?, ?)`);
const listLogsStmt  = db.prepare(`SELECT * FROM logs ORDER BY id DESC LIMIT ?`);
const pruneLogsStmt = db.prepare(`DELETE FROM logs WHERE id <= (SELECT MAX(id) - ? FROM logs)`);

function log(origin, source, message) {
  try {
    insertLogStmt.run(nowIso(), origin || '', source || '', String(message).slice(0, 1000));
  } catch (e) { console.error('log write failed:', e.message); }
}

module.exports = {
  db, DB_PATH, nowIso,
  insertPrices, latestByCell, historyStmt, prunePrices,
  lastUpdated: () => lastUpdatedStmt.get().ts,
  priceCount: () => priceCountStmt.get().n,
  upsertPin: p => upsertPinStmt.run(p),
  listPins: () => listPinsStmt.all(),
  deletePin: (d, p, g, s) => deletePinStmt.run(d, p, g, s).changes,
  seedStores,
  listStores: () => listStoresStmt.all(),
  getStore: id => getStoreStmt.get(id),
  saveCalculator: (id, calc) => saveCalcStmt.run(JSON.stringify(calc), nowIso(), id).changes,
  resetCalculator: id => resetCalcStmt.run(nowIso(), id).changes,
  getPref: (k, fallback) => { const r = getPrefStmt.get(k); try { return r ? JSON.parse(r.v) : fallback; } catch (e) { return fallback; } },
  setPref: (k, v) => setPrefStmt.run(k, JSON.stringify(v), nowIso()),
  priceAsOf,
  setManualRetail: r => setManualRetailStmt.run(r),
  clearManualRetail: (store, d, p, g) => clearManualRetailStmt.run(store, d, p, g).changes,
  listManualRetail: store => listManualRetailStmt.all(store),
  addCustomDevice: r => addCustomDeviceStmt.run(r),
  listCustomDevices: () => listCustomDevicesStmt.all(),
  deleteCustomDevice: id => deleteCustomDeviceStmt.run(id).changes,
  setCustomDeviceEnabled: (id, on) => setCustomDeviceEnabledStmt.run(on ? 1 : 0, id).changes,
  setFlag: r => setFlagStmt.run(r),
  clearFlag: (d, p, f) => clearFlagStmt.run(d, p, f).changes,
  listFlags: () => listFlagsStmt.all(),
  log,
  listLogs: n => listLogsStmt.all(n || 200),
  pruneLogs: n => pruneLogsStmt.run(n || 2000).changes,
};
