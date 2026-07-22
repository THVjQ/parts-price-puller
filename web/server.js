/**
 * Parts Price Puller — web app.
 * Replaces the Google Sheet: wholesale matrix, per-store retail calculators,
 * Setup-Mode pins, and the ingest endpoint the scraper + userscript push to.
 *
 * Data lives in two places, deliberately:
 *   config/*.yml  (git, live-reloaded)  — devices, parts, schedule, store SEEDS
 *   data/prices.db (volume, never git)  — prices, pins, per-store calculator edits
 */
const path = require('path');
const express = require('express');

const config = require('./lib/config');
const db = require('./lib/db');
const auth = require('./lib/auth');
const gitsync = require('./lib/gitsync');
const calc = require('./public/calc.js');

const PORT = Number(process.env.PORT) || 8080;
const INGEST_KEY = process.env.INGEST_KEY || '';
const VERSION = require('./package.json').version;

if (!INGEST_KEY) {
  console.error('FATAL: INGEST_KEY is not set — the scraper and userscript would have no way to authenticate.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY || 1);   // Cloudflare / reverse proxy
app.use(express.json({ limit: '4mb' }));

// ───────────────────────────────────────────────────────── helpers
const clean = s => String(s == null ? '' : s).trim();
const nowIso = () => new Date().toISOString();

function keyOk(req) {
  const given = req.get('X-Key') || req.query.key || '';
  return Boolean(given) && given === INGEST_KEY;
}
function requireKey(req, res, next) {
  if (keyOk(req)) return next();
  res.status(401).json({ error: 'bad key' });
}
function requireKeyOrSession(req, res, next) {
  if (keyOk(req) || auth.isLoggedIn(req)) return next();
  res.status(401).json({ error: 'unauthorised' });
}
function requireSession(req, res, next) {
  if (auth.isLoggedIn(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'login required' });
  res.redirect('/login');
}

// Case-insensitive device lookup so "iphone 12 pro" from a scraper still lands on the
// canonical row name. Rebuilt whenever the config reloads.
let deviceIndex = new Map(), partIndex = new Map();
function reindex(cfg) {
  deviceIndex = new Map(cfg.devices.map(d => [d.name.toLowerCase(), d]));
  partIndex = new Map(cfg.parts.map(p => [p.key.toUpperCase(), p]));
}
config.onChange(cfg => { reindex(cfg); db.seedStores(cfg.storeSeeds); });

// Graded parts (LCD/OLED) keep one price per grade; everything else is grade-agnostic
// and stored under ''. Doing this once here means neither the scraper, the userscript
// nor the UI has to remember the rule.
function gradeFor(part, requested, cfg) {
  const p = partIndex.get(String(part).toUpperCase());
  if (!p || !p.graded) return '';
  const g = clean(requested) || cfg.grades.default;
  return cfg.grades.list.includes(g) ? g : cfg.grades.default;
}

// ───────────────────────────────────────────────────────── public endpoints
app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: VERSION, auth: auth.MODE });
});

app.post('/api/login', (req, res) => {
  if (auth.MODE !== 'password') return res.json({ ok: true, note: 'auth mode ' + auth.MODE });
  const ip = req.ip || 'unknown';
  if (auth.tooManyAttempts(ip)) return res.status(429).json({ error: 'Too many attempts — wait 15 minutes.' });
  const ok = auth.checkPassword((req.body || {}).password);
  auth.noteAttempt(ip, ok);
  if (!ok) return res.status(401).json({ error: 'Wrong password.' });
  auth.setSession(res);
  db.log('web', '', 'Login from ' + ip);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => { auth.clearSession(res); res.json({ ok: true }); });

app.get('/login', (req, res) => {
  if (auth.isLoggedIn(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ───────────────────────────────────────────────────────── machine endpoints (X-Key)
/**
 * Everything the scraper / userscript needs in one call — the shape the old Apps
 * Script `?action=config` returned, so the pull loops did not have to be rewritten.
 */
app.get('/api/config', requireKeyOrSession, (req, res) => {
  const cfg = config.get();
  res.json({
    grade: cfg.grades.default,
    grades: cfg.grades.list,
    scheduleDay: cfg.schedule.day,
    scheduleHour: cfg.schedule.hour,
    rateLimitMs: cfg.pull.rateLimitMs,
    maxResults: cfg.pull.maxResults,
    devices: cfg.devices.filter(d => d.enabled),
    parts: cfg.parts.map(p => p.key),
    partLabels: cfg.parts.map(p => ({ key: p.key, label: p.label, graded: p.graded })),
    queries: cfg.parts.map(p => ({
      part: p.key,
      template: p.query,
      match: p.must.join(';'),
      exclude: p.exclude.join(';'),
      graded: p.graded,
    })),
    sources: cfg.sources.filter(s => s.enabled),
    pins: db.listPins().map(p => ({
      device: p.device, part: p.part, grade: p.grade, source: p.source,
      productId: p.product_id, variantId: p.variant_id, title: p.title, url: p.url, price: p.price,
    })),
  });
});

/**
 * POST /api/ingest — a batch of prices from the scraper or the userscript.
 * Accepts both the new shape {source:'CP', origin:'tm', results:[…]} and the old
 * Apps Script one {site:'CP', source:'tm', results:[…]}.
 */
app.post('/api/ingest', requireKey, (req, res) => {
  const cfg = config.get();
  const body = req.body || {};
  const supplier = clean(body.site || body.source || 'CP').toUpperCase();
  const origin = clean(body.site ? body.source : body.origin) || 'unknown';
  const results = Array.isArray(body.results) ? body.results : [];

  const ts = nowIso();
  const rows = [];
  let skipped = 0;
  for (const r of results) {
    const device = deviceIndex.get(clean(r.device).toLowerCase());
    const part = partIndex.get(clean(r.part).toUpperCase());
    if (!device || !part) { skipped++; continue; }
    const price = r.price === null || r.price === undefined || r.price === '' ? null : Number(r.price);
    rows.push({
      device: device.name,
      part: part.key,
      grade: gradeFor(part.key, r.grade, cfg),
      source: clean(r.source || supplier).toUpperCase(),
      price: Number.isFinite(price) && price > 0 ? price : null,
      url: clean(r.url).slice(0, 500),
      matched_title: clean(r.title || r.matched_title).slice(0, 300),
      ts,
    });
  }
  if (rows.length) db.insertPrices(rows);
  db.log(origin, supplier, `Ingested ${rows.length} prices${skipped ? ` (${skipped} skipped — unknown device/part)` : ''}`);
  maybePrune(cfg);
  res.json({ ok: true, written: rows.length, skipped });
});

app.post('/api/log', requireKey, (req, res) => {
  const b = req.body || {};
  db.log(clean(b.origin || b.source) || 'unknown', clean(b.site || '').toUpperCase(), clean(b.message));
  res.json({ ok: true });
});

// Manual/webhook trigger for an immediate config refresh from git.
app.post('/api/git/pull', requireKeyOrSession, async (req, res) => {
  const r = await gitsync.pull();
  config.invalidate();
  config.get();
  db.log('web', '', `git sync: ${r.ok ? 'ok @ ' + r.head : 'FAILED — ' + r.message}`);
  res.json(r);
});

// ───────────────────────────────────────────────────────── pins
app.get('/api/pins', requireKeyOrSession, (req, res) => {
  res.json({ pins: db.listPins() });
});

app.post('/api/pins', requireKeyOrSession, (req, res) => {
  const cfg = config.get();
  const b = req.body || {};
  const device = deviceIndex.get(clean(b.device).toLowerCase());
  const part = partIndex.get(clean(b.part).toUpperCase());
  if (!device || !part) return res.status(400).json({ error: 'unknown device or part' });

  const grade = gradeFor(part.key, b.grade, cfg);
  const source = clean(b.source || 'CP').toUpperCase();
  const price = b.price === '' || b.price == null ? null : Number(b.price);
  db.upsertPin({
    device: device.name, part: part.key, grade, source,
    product_id: clean(b.productId || b.product_id),
    variant_id: clean(b.variantId || b.variant_id),
    title: clean(b.title).slice(0, 300),
    url: clean(b.url).slice(0, 500),
    price: Number.isFinite(price) && price > 0 ? price : null,
    ts: nowIso(),
  });
  // A pin arrives with the price that was on screen — drop it straight into the matrix
  // so the cell fills in immediately instead of waiting for the next pull.
  if (Number.isFinite(price) && price > 0) {
    db.insertPrices([{
      device: device.name, part: part.key, grade, source,
      price, url: clean(b.url).slice(0, 500), matched_title: clean(b.title).slice(0, 300), ts: nowIso(),
    }]);
  }
  db.log(clean(b.origin || b.source_origin) || 'tm', source, `Pinned ${device.name} / ${part.key}${grade ? ' [' + grade + ']' : ''} → ${clean(b.title) || b.productId}`);
  res.json({ ok: true });
});

app.delete('/api/pins', requireKeyOrSession, (req, res) => {
  const cfg = config.get();
  const b = Object.keys(req.body || {}).length ? req.body : req.query;
  const part = clean(b.part).toUpperCase();
  const n = db.deletePin(clean(b.device), part, gradeFor(part, b.grade, cfg), clean(b.source || 'CP').toUpperCase());
  db.log('web', '', `Unpinned ${b.device} / ${b.part}`);
  res.json({ ok: true, removed: n });
});

// ───────────────────────────────────────────────────────── stores
function storeOut(row) {
  let calculator;
  try { calculator = config.normaliseCalculator(JSON.parse(row.calculator_json)); }
  catch (e) { calculator = config.normaliseCalculator({}); }
  return { id: row.id, name: row.name, calculator, edited: row.edited === 1, updatedAt: row.updated_at };
}

app.get('/api/stores', requireKeyOrSession, (req, res) => {
  res.json({ stores: db.listStores().map(storeOut) });
});

app.put('/api/stores/:id/calculator', requireSession, (req, res) => {
  const row = db.getStore(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such store' });
  const calculator = config.normaliseCalculator(req.body || {});
  db.saveCalculator(row.id, calculator);
  db.log('web', '', `Calculator saved for ${row.name}`);
  res.json({ ok: true, store: storeOut(db.getStore(row.id)) });
});

// Back to whatever config/stores.yml currently says.
app.delete('/api/stores/:id/calculator', requireSession, (req, res) => {
  const row = db.getStore(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such store' });
  db.resetCalculator(row.id);
  db.log('web', '', `Calculator reset to git defaults for ${row.name}`);
  res.json({ ok: true, store: storeOut(db.getStore(row.id)) });
});

// ───────────────────────────────────────────────────────── the matrix
/**
 * GET /api/prices?grade=BQ7[&store=lismore]
 * One row per enabled device, one cell per part: the cheapest live price across the
 * enabled sources, or the MANUAL price if one exists (that always wins — it is the
 * replacement for the sheet's blue "human typed this" cells).
 */
app.get('/api/prices', requireKeyOrSession, (req, res) => {
  const cfg = config.get();
  const grade = cfg.grades.list.includes(clean(req.query.grade)) ? clean(req.query.grade) : cfg.grades.default;
  const latest = db.latestByCell(grade);
  const sourceKeys = cfg.sources.filter(s => s.enabled).map(s => s.key);

  const pinned = new Set(db.listPins().map(p => `${p.device}|${p.part}`));

  const rows = cfg.devices.filter(d => d.enabled).map(d => {
    const cells = {};
    for (const part of cfg.parts) {
      const offers = [];
      let manual = null;
      for (const src of sourceKeys.concat('MANUAL')) {
        const hit = latest.get(`${d.name}|${part.key}|${src}`);
        if (!hit || hit.price == null) continue;
        const offer = {
          source: src, price: hit.price, url: hit.url,
          title: hit.matched_title, ts: hit.ts, prev: hit.prev == null ? null : hit.prev,
        };
        if (src === 'MANUAL') manual = offer; else offers.push(offer);
      }
      offers.sort((a, b) => a.price - b.price);
      const best = manual || offers[0] || null;
      // A cell that was searched but matched nothing still deserves a tooltip saying so.
      const miss = best ? null : (latest.get(`${d.name}|${part.key}|${sourceKeys[0]}`) || null);
      cells[part.key] = best
        ? {
            price: best.price, source: best.source, url: best.url, title: best.title,
            ts: best.ts, prev: best.prev, manual: Boolean(manual),
            alt: offers.filter(o => o !== best).map(o => ({ source: o.source, price: o.price })),
            pinned: pinned.has(`${d.name}|${part.key}`),
          }
        : {
            price: null, source: null, ts: miss ? miss.ts : null,
            title: miss ? miss.matched_title : null, url: miss ? miss.url : null,
            pinned: pinned.has(`${d.name}|${part.key}`),
          };
    }
    return { device: d.name, group: d.group, cells };
  });

  const store = req.query.store ? db.getStore(clean(req.query.store)) : null;
  if (store) {
    const c = storeOut(store).calculator;
    for (const row of rows) {
      for (const key of Object.keys(row.cells)) {
        const cell = row.cells[key];
        cell.retail = cell.price == null ? null : calc.computeRetail(cell.price, c, cfg.site.gstPercent);
      }
    }
  }

  res.json({
    grade,
    grades: cfg.grades.list,
    groups: cfg.groups,
    parts: cfg.parts.map(p => ({ key: p.key, label: p.label.replace('{grade}', grade), graded: p.graded })),
    sources: cfg.sources.filter(s => s.enabled).map(s => ({ key: s.key, label: s.label })),
    site: cfg.site,
    rows,
    updated: db.lastUpdated(),
    store: store ? store.id : null,
  });
});

app.get('/api/history', requireKeyOrSession, (req, res) => {
  const cfg = config.get();
  const grade = cfg.grades.list.includes(clean(req.query.grade)) ? clean(req.query.grade) : cfg.grades.default;
  res.json({ history: db.historyStmt.all(clean(req.query.device), clean(req.query.part).toUpperCase(), grade) });
});

app.get('/api/logs', requireSession, (req, res) => {
  res.json({ logs: db.listLogs(Number(req.query.limit) || 200) });
});

app.get('/api/status', requireSession, (req, res) => {
  const cfg = config.get();
  res.json({
    version: VERSION,
    auth: auth.MODE,
    config: config.status(),
    git: gitsync.status(),
    counts: { devices: cfg.devices.length, parts: cfg.parts.length, stores: db.listStores().length, prices: db.priceCount(), pins: db.listPins().length },
    schedule: cfg.schedule,
    updated: db.lastUpdated(),
  });
});

// ───────────────────────────────────────────────────────── static
// The login page needs its own chrome before anyone is logged in. Exactly these three
// files are public; everything else in public/ is behind the session gate.
const statics = express.static(path.join(__dirname, 'public'), { index: 'index.html', extensions: ['html'] });
const OPEN_ASSETS = new Set(['/styles.css', '/logo.svg', '/favicon.svg']);
app.use((req, res, next) => (OPEN_ASSETS.has(req.path) ? statics(req, res, next) : next()));

app.use(requireSession);
app.use(statics);

// ───────────────────────────────────────────────────────── housekeeping
let lastPrune = 0;
function maybePrune(cfg) {
  if (Date.now() - lastPrune < 6 * 3600 * 1000) return;
  lastPrune = Date.now();
  const n = db.prunePrices(cfg.retention.priceHistoryDays);
  db.pruneLogs(cfg.retention.logRows);
  if (n) console.log(`[db] pruned ${n} price rows older than ${cfg.retention.priceHistoryDays} days`);
}

// ───────────────────────────────────────────────────────── boot
(function start() {
  // git first: on a cold container the bind mount may not have the repo yet, and the
  // config loader would have nothing to read.
  gitsync.start(() => { config.invalidate(); config.get(); });

  let cfg;
  try {
    cfg = config.get();
  } catch (e) {
    console.error('FATAL: could not load config from', config.CONFIG_DIR, '-', e.message);
    process.exit(1);
  }
  reindex(cfg);
  db.seedStores(cfg.storeSeeds);
  config.startWatching(5000);
  maybePrune(cfg);

  app.listen(PORT, () => {
    console.log(`Parts Price Puller v${VERSION} on :${PORT} — auth=${auth.MODE}, config=${config.CONFIG_DIR}, db=${db.DB_PATH}`);
    db.log('system', '', `Web app started (v${VERSION})`);
  });
})();
