#!/usr/bin/env node
/**
 * One-shot migration: Google Sheet → prices.db.
 *
 * Export the old sheet's tabs as CSV (File → Download → Comma-separated values) and
 * feed them in. Nothing else in the sheet needs to survive: devices and parts are
 * already in config/*.yml, and the calculators live in config/stores.yml.
 *
 *   node tools/import-sheet-csv.js --prices Prices.csv [--pins Pins.csv] [--grade BQ7]
 *
 * Options
 *   --prices FILE   the "Prices" tab. Row 1 = labels, row 2 = part keys, rows 3+ = devices.
 *   --pins FILE     the "Pins" tab: Device, Part, Product ID, Variant ID, Title, Price, Pinned At.
 *   --grade G       which grade the graded columns (LCD/OLED) belong to. Default: settings.yml.
 *   --source KEY    supplier the prices came from. Default CP.
 *   --manual        import every price as MANUAL instead — MANUAL always wins in the
 *                   matrix and no pull overwrites it. Use this for a sheet full of
 *                   hand-typed (blue) cells; CSV export does not carry cell colours.
 *   --dry-run       parse and report, write nothing.
 *
 * In Docker:  docker compose exec web node tools/import-sheet-csv.js --prices /repo/import/Prices.csv
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : fallback;
};
const DRY = Boolean(opt('dry-run', false));
const MANUAL = Boolean(opt('manual', false));

if (!opt('prices', null) && !opt('pins', null)) {
  console.error('Usage: node tools/import-sheet-csv.js --prices Prices.csv [--pins Pins.csv] [--grade BQ7] [--manual] [--dry-run]');
  process.exit(1);
}

process.env.CONFIG_DIR = process.env.CONFIG_DIR || path.join(__dirname, '..', '..', 'config');
process.env.DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

const config = require('../lib/config');
const db = require('../lib/db');

const cfg = config.get();
const deviceByName = new Map(cfg.devices.map(d => [d.name.toLowerCase(), d.name]));
const partKeys = new Set(cfg.parts.map(p => p.key));
const gradedParts = new Set(cfg.parts.filter(p => p.graded).map(p => p.key));
const GRADE = String(opt('grade', cfg.grades.default));
const SOURCE = MANUAL ? 'MANUAL' : String(opt('source', 'CP')).toUpperCase();

// Minimal RFC4180 parser — Sheets quotes any field containing a comma, quote or newline.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const money = v => {
  const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

let wrote = 0;
const unknownDevices = new Set(), unknownParts = new Set();

// ── Prices grid ─────────────────────────────────────────────────────────────
if (opt('prices', null)) {
  const rows = parseCsv(fs.readFileSync(String(opt('prices')), 'utf8'));
  if (rows.length < 3) { console.error('Prices CSV looks too short — expected the grid with 2 header rows.'); process.exit(1); }

  // Row 2 carries the machine part keys the old Code.gs wrote under each label.
  const keyRow = rows[1].map(s => String(s).trim().toUpperCase());
  const colToPart = new Map();
  keyRow.forEach((k, i) => { if (i > 0 && partKeys.has(k)) colToPart.set(i, k); });

  if (!colToPart.size) {
    console.error('No part keys found in row 2 of the prices CSV. Expected LCD, OLED, BAT_AM …');
    console.error('Row 2 was:', keyRow.join(' | '));
    process.exit(1);
  }

  const ts = new Date().toISOString();
  const batch = [];
  for (let r = 2; r < rows.length; r++) {
    const rawName = String(rows[r][0] || '').trim();
    if (!rawName) continue;
    const device = deviceByName.get(rawName.toLowerCase());
    if (!device) { unknownDevices.add(rawName); continue; }

    for (const [col, part] of colToPart) {
      const price = money(rows[r][col]);
      if (price == null) continue;
      batch.push({
        device, part,
        grade: gradedParts.has(part) ? GRADE : '',
        source: SOURCE,
        price,
        url: '',
        matched_title: 'Imported from the Google Sheet',
        ts,
      });
    }
  }
  console.log(`prices: ${batch.length} cells from ${rows.length - 2} sheet rows → source ${SOURCE}${GRADE ? ', graded columns as ' + GRADE : ''}`);
  if (!DRY && batch.length) { db.insertPrices(batch); wrote += batch.length; }
}

// ── Pins tab ────────────────────────────────────────────────────────────────
if (opt('pins', null)) {
  const rows = parseCsv(fs.readFileSync(String(opt('pins')), 'utf8'));
  let n = 0;
  for (let r = 1; r < rows.length; r++) {          // row 0 = header
    const [dev, part, productId, variantId, title, price] = rows[r].map(s => String(s || '').trim());
    if (!dev || !part) continue;
    const device = deviceByName.get(dev.toLowerCase());
    const partKey = part.toUpperCase();
    if (!device) { unknownDevices.add(dev); continue; }
    if (!partKeys.has(partKey)) { unknownParts.add(part); continue; }
    n++;
    if (DRY) continue;
    db.upsertPin({
      device, part: partKey,
      grade: gradedParts.has(partKey) ? GRADE : '',
      source: SOURCE === 'MANUAL' ? 'CP' : SOURCE,
      product_id: productId, variant_id: variantId,
      title, url: '', price: money(price),
      ts: new Date().toISOString(),
    });
  }
  console.log(`pins: ${n} imported`);
}

if (unknownDevices.size) {
  console.warn(`\n⚠ ${unknownDevices.size} device name(s) in the sheet are not in config/devices.yml — their prices were skipped:`);
  [...unknownDevices].sort().forEach(d => console.warn('   ' + d));
  console.warn('   Add them to config/devices.yml (or rename them to match) and re-run.');
}
if (unknownParts.size) console.warn(`\n⚠ unknown part keys skipped: ${[...unknownParts].join(', ')}`);

console.log(DRY ? '\nDry run — nothing written.' : `\nDone — ${wrote} price rows written to ${db.DB_PATH}`);
