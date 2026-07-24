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
const crypto = require('crypto');
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
// Keep the raw body: the GitHub webhook signature is an HMAC over the exact bytes.
app.use(express.json({ limit: '4mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

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

// Effective device list = git-defined (config/devices.yml) + ones added from the site's
// Edit menu (DB). Built fresh each call so a just-added device shows up immediately.
// A DB device with the same name as a git one is ignored (git wins).
function effectiveParts(cfg) {
  const knownKeys = new Set(cfg.parts.map(p => p.key.toLowerCase()));
  const custom = db.listCustomParts()
    .filter(p => !knownKeys.has(p.key.toLowerCase()))
    .map(p => ({ key: p.key, label: p.label, graded: false, custom: true, id: p.id }));
  return cfg.parts.concat(custom);
}

function effectiveDevices(cfg) {
  const known = new Set(cfg.devices.map(d => d.name.toLowerCase()));
  const groupIds = new Set(cfg.groups.map(g => g.id));
  const custom = db.listCustomDevices()
    .filter(d => !known.has(d.name.toLowerCase()))
    .map(d => ({
      name: d.name,
      search: d.search || d.name,
      group: groupIds.has(d.grp) ? d.grp : 'other',
      aliases: d.aliases ? d.aliases.split(';').map(s => s.trim()).filter(Boolean) : [],
      enabled: d.enabled === 1,
      custom: true,
      id: d.id,
    }));
  return cfg.devices.concat(custom);
}

// Case-insensitive device lookup so "iphone 12 pro" from a scraper still lands on the
// canonical row name. Rebuilt whenever the config reloads or a custom device changes.
let deviceIndex = new Map(), partIndex = new Map();
function reindex(cfg) {
  cfg = cfg || config.get();
  deviceIndex = new Map(effectiveDevices(cfg).map(d => [d.name.toLowerCase(), d]));
  partIndex = new Map(effectiveParts(cfg).map(p => [p.key.toUpperCase(), p]));
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
  const b = req.body || {};
  const ok = auth.checkLogin(b.username, b.password);
  auth.noteAttempt(ip, ok);
  if (!ok) return res.status(401).json({ error: 'Wrong username or password.' });
  const token = auth.setSession(req, res);
  db.log('web', '', 'Login from ' + ip);
  // token also returned in the body so the userscript can send it as an X-PPP-Session
  // header — cross-site calls can't rely on the SameSite=Lax cookie.
  res.json({ ok: true, token });
});

app.post('/api/logout', (req, res) => { auth.clearSession(req, res); res.json({ ok: true }); });

app.get('/login', (req, res) => {
  if (auth.isLoggedIn(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ───────────────────────────────────────────────────────── GitHub webhook
// Same deal as the THVjQ-Website deployer: point a GitHub push webhook here and a
// commit to config/*.yml is live in seconds instead of waiting for the poll.
//   Payload URL:  https://pricing.thvjq.com.au/hooks/pricing
//   Content type: application/json     Secret: WEBHOOK_SECRET     Event: push
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

function validSignature(req) {
  if (!WEBHOOK_SECRET) return true;                     // unset = accept (not recommended)
  const sig = req.get('X-Hub-Signature-256') || '';
  const want = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.rawBody || Buffer.alloc(0)).digest('hex');
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

app.get('/hooks/pricing', (req, res) => res.type('text').send('ok'));

app.post('/hooks/pricing', async (req, res) => {
  if (!validSignature(req)) return res.status(401).type('text').send('bad signature');
  const event = req.get('X-GitHub-Event') || '';
  if (event === 'ping') return res.type('text').send('pong');
  if (event !== 'push') return res.type('text').send('ignored event: ' + event);

  const r = await gitsync.pull();
  config.invalidate();
  config.get();
  db.log('system', '', `Webhook deploy: ${r.ok ? 'ok @ ' + r.head + ' — ' + r.message : 'FAILED — ' + r.message}`);
  res.status(r.ok ? 200 : 500).type('text').send(r.ok ? 'deployed ' + r.head : 'deploy failed');
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
    devices: effectiveDevices(cfg).filter(d => d.enabled),
    parts: effectiveParts(cfg).map(p => p.key),
    partLabels: effectiveParts(cfg).map(p => ({ key: p.key, label: p.label, graded: p.graded || false })),
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
 * Auth: the scraper still uses X-Key; the userscript now rides the logged-in session
 * (username + passcode), so either one is accepted.
 */
app.post('/api/ingest', requireKeyOrSession, (req, res) => {
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

app.post('/api/log', requireKeyOrSession, (req, res) => {
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
  const device = clean(b.device);
  const part = clean(b.part).toUpperCase();
  if (!device || !part) return res.status(400).json({ error: 'device and part required' });
  let n;
  if (b.source) {
    // TM panel: knows exact (device, part, grade, source) from GET /api/pins — use exact match.
    n = db.deletePin(device, part, gradeFor(part, b.grade, cfg), clean(b.source).toUpperCase());
  } else {
    // Web UI "Unpin this cell": only knows device+part (grade and source at pin time may differ
    // from the current UI grade selection) — delete all pins for this cell regardless of grade/source.
    n = db.deletePinsForCell(device, part);
  }
  db.log('web', '', `Unpinned ${device} / ${part} (removed ${n})`);
  res.json({ ok: true, removed: n });
});

// ───────────────────────────────────────────────────────── manual prices
/**
 * A price a human typed in (right-click a cell → Edit). Two kinds:
 *   kind:'wholesale' (default) — a MANUAL cost that wins over every supplier and feeds
 *      the calculator, so every store's retail follows from it. Store-agnostic.
 *   kind:'retail' — a fixed RETAIL figure for ONE store (retail depends on that store's
 *      calculator, so it can't be shared). Overrides the calculated retail for that cell.
 * price:null clears whichever kind was set.
 */
app.post('/api/manual', requireSession, (req, res) => {
  const cfg = config.get();
  const b = req.body || {};
  const device = deviceIndex.get(clean(b.device).toLowerCase());
  const part = partIndex.get(clean(b.part).toUpperCase());
  if (!device || !part) return res.status(400).json({ error: 'unknown device or part' });

  const grade = gradeFor(part.key, b.grade, cfg);
  const raw = b.price === '' || b.price == null ? null : Number(b.price);
  const price = Number.isFinite(raw) && raw > 0 ? raw : null;
  const kind = b.kind === 'retail' ? 'retail' : 'wholesale';

  if (kind === 'retail') {
    const store = db.getStore(clean(b.store));
    if (!store) return res.status(400).json({ error: 'a store must be selected to set a retail price' });
    if (price == null) db.clearManualRetail(store.id, device.name, part.key, grade);
    else db.setManualRetail({ store: store.id, device: device.name, part: part.key, grade, price, ts: nowIso() });
    db.log('web', 'MANUAL', `${price == null ? 'Cleared' : 'Set'} retail ${device.name}/${part.key} @ ${store.name}${price == null ? '' : ' = ' + price}`);
    return res.json({ ok: true, price, kind });
  }

  db.insertPrices([{
    device: device.name, part: part.key, grade, source: 'MANUAL',
    price,
    url: '',
    // A tombstone row (price null) is how "clear" works: history stays intact and the
    // cell drops back to the cheapest supplier price on the next read.
    matched_title: price == null ? 'Manual price cleared' : clean(b.note) || 'Entered by hand',
    ts: nowIso(),
  }]);
  db.log('web', 'MANUAL', `${price == null ? 'Cleared' : 'Set'} ${device.name} / ${part.key}${grade ? ' [' + grade + ']' : ''}${price == null ? '' : ' = ' + price}`);
  res.json({ ok: true, price, kind });
});

// ───────────────────────────────────────────────────────── cell flags
// Flags apply across ALL stores (no store column) — a compat issue on a part affects
// every store equally. Three types: 'compat', 'microsolder', 'warning'.
const FLAG_TYPES = new Set(['compat', 'microsolder', 'warning']);

app.get('/api/flags', requireSession, (req, res) => {
  res.json({ flags: db.listFlags() });
});

app.post('/api/flags', requireSession, (req, res) => {
  const b = req.body || {};
  const device = deviceIndex.get(clean(b.device).toLowerCase());
  const part = partIndex.get(clean(b.part).toUpperCase());
  if (!device || !part) return res.status(400).json({ error: 'unknown device or part' });
  if (!FLAG_TYPES.has(b.flag)) return res.status(400).json({ error: 'flag must be compat, microsolder or warning' });
  db.setFlag({ device: device.name, part: part.key, flag: b.flag, note: clean(b.note).slice(0, 300), ts: nowIso() });
  db.log('web', '', `Flag set: ${device.name}/${part.key} = ${b.flag}`);
  res.json({ ok: true });
});

app.delete('/api/flags', requireSession, (req, res) => {
  const b = Object.keys(req.body || {}).length ? req.body : req.query;
  const device = deviceIndex.get(clean(b.device).toLowerCase());
  const part = partIndex.get(clean(b.part).toUpperCase());
  if (!device || !part) return res.status(400).json({ error: 'unknown device or part' });
  if (!FLAG_TYPES.has(b.flag)) return res.status(400).json({ error: 'invalid flag type' });
  const n = db.clearFlag(device.name, part.key, b.flag);
  db.log('web', '', `Flag cleared: ${device.name}/${part.key} = ${b.flag}`);
  res.json({ ok: true, removed: n });
});

// ───────────────────────────────────────────────────────── custom devices
app.get('/api/devices', requireSession, (req, res) => {
  res.json({ devices: db.listCustomDevices() });
});

app.post('/api/devices', requireSession, (req, res) => {
  const cfg = config.get();
  const b = req.body || {};
  const name = clean(b.name).slice(0, 60);
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (deviceIndex.has(name.toLowerCase())) return res.status(409).json({ error: 'a device with that name already exists' });
  const groupIds = new Set(cfg.groups.map(g => g.id));
  const grp = groupIds.has(clean(b.group)) ? clean(b.group) : 'other';
  db.addCustomDevice({
    name, search: clean(b.search) || name, grp,
    aliases: clean(b.aliases).slice(0, 200), ts: nowIso(),
  });
  reindex(cfg);
  db.log('web', '', `Added device ${name} (${grp})`);
  res.json({ ok: true, devices: db.listCustomDevices() });
});

app.delete('/api/devices/:id', requireSession, (req, res) => {
  db.deleteCustomDevice(Number(req.params.id));
  reindex();
  db.log('web', '', `Removed custom device #${req.params.id}`);
  res.json({ ok: true, devices: db.listCustomDevices() });
});

// ───────────────────────────────────────────────────────── custom parts (columns)
app.get('/api/parts', requireSession, (req, res) => {
  res.json({ parts: db.listCustomParts() });
});

app.post('/api/parts', requireSession, (req, res) => {
  const b = req.body || {};
  const label = clean(b.label).slice(0, 60);
  if (!label) return res.status(400).json({ error: 'label is required' });
  const key = (clean(b.key) || label.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')).slice(0, 40);
  if (!key) return res.status(400).json({ error: 'invalid key' });
  const family = clean(b.family || '').slice(0, 40);  // '' = all families
  const cfg = config.get();
  if (cfg.parts.some(p => p.key.toLowerCase() === key.toLowerCase())) {
    return res.status(409).json({ error: 'conflicts with a built-in column key' });
  }
  try {
    db.addCustomPart({ key, label, query: clean(b.query) || '', family, ts: nowIso() });
    reindex();
    db.log('web', '', `Custom column added: ${key} (${label}) family=${family || 'all'}`);
    res.json({ ok: true, parts: db.listCustomParts() });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'a column with that key already exists' });
    throw e;
  }
});

app.delete('/api/parts/:id', requireSession, (req, res) => {
  const n = db.deleteCustomPart(Number(req.params.id));
  if (!n) return res.status(404).json({ error: 'not found' });
  reindex();
  db.log('web', '', `Custom column removed: id ${req.params.id}`);
  res.json({ ok: true, parts: db.listCustomParts() });
});

// ─────────────────────────────────────── device + column ordering (saved in prefs)
app.put('/api/device-order', requireSession, (req, res) => {
  const { family, order } = req.body || {};
  if (!family || !Array.isArray(order)) return res.status(400).json({ error: 'family and order[] required' });
  const current = db.getPref('device_order', {});
  current[String(family)] = order.map(String);
  db.setPref('device_order', current);
  res.json({ ok: true });
});

app.put('/api/column-order', requireSession, (req, res) => {
  const { family, order } = req.body || {};
  if (!family || !Array.isArray(order)) return res.status(400).json({ error: 'family and order[] required' });
  const current = db.getPref('column_order', {});
  current[String(family)] = order.map(String);
  db.setPref('column_order', current);
  res.json({ ok: true });
});

// ───────────────────────────────────────────────────────── prefs
// One shared login, so "which store am I" belongs on the server — log in anywhere and
// the site comes back the way you left it.
app.get('/api/prefs', requireSession, (req, res) => {
  res.json({ prefs: db.getPref('ui', {}) });
});

app.put('/api/prefs', requireSession, (req, res) => {
  const b = req.body || {};
  const prefs = {
    store: clean(b.store).slice(0, 60),
    grade: clean(b.grade).slice(0, 30),
    view: ['wholesale', 'retail', 'both'].includes(b.view) ? b.view : 'wholesale',
    family: clean(b.family).slice(0, 40),
  };
  db.setPref('ui', prefs);
  res.json({ ok: true, prefs });
});

// ───────────────────────────────────────────────────────── stores
function storeOut(row) {
  let calculator;
  try { calculator = config.normaliseCalculator(JSON.parse(row.calculator_json)); }
  catch (e) { calculator = config.normaliseCalculator({}); }
  // Unedited stores inherit the global calculator when it's set.
  if (row.edited !== 1) {
    const gc = db.getPref('global_calc', null);
    if (gc) try { calculator = config.normaliseCalculator(gc); } catch (e) { /* malformed pref — ignore */ }
  }
  // Per-store retail overrides travel with the store so the browser can apply them the
  // instant you switch store, without another round trip.
  const retailOverrides = {};
  for (const r of db.listManualRetail(row.id)) retailOverrides[`${r.device}|${r.part}|${r.grade}`] = r.price;
  return { id: row.id, name: row.name, calculator, retailOverrides, edited: row.edited === 1, updatedAt: row.updated_at };
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

// ── Global calculator: default markup inherited by all unedited stores ────────
app.get('/api/global-calc', requireKeyOrSession, (req, res) => {
  const gc = db.getPref('global_calc', null);
  res.json({ calculator: gc ? config.normaliseCalculator(gc) : null });
});

app.put('/api/global-calc', requireSession, (req, res) => {
  const calculator = config.normaliseCalculator(req.body || {});
  db.setPref('global_calc', calculator);
  db.log('web', '', 'Global calculator saved');
  res.json({ ok: true, calculator });
});

app.delete('/api/global-calc', requireSession, (req, res) => {
  db.setPref('global_calc', null);
  db.log('web', '', 'Global calculator cleared (stores fall back to git seeds)');
  res.json({ ok: true });
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

  // Map from "device|part" → source string ('CP', 'TPH', 'IMOBILE', …) for coloured pin dots.
  const pinned = new Map(db.listPins().map(p => [`${p.device}|${p.part}`, p.source || 'CP']));
  // Reference price for the trend colour: what the winning source was at ~4 weeks ago.
  const TREND_DAYS = 28;
  const asOf = db.priceAsOf(grade, new Date(Date.now() - TREND_DAYS * 86400000).toISOString());

  // Each family shows only its own columns (iPad = LCD + Digitiser, phones = the full
  // set, …). Custom parts appear in every family; stored column order applied per-family.
  const allParts = effectiveParts(cfg);  // global — used for partByKey and allKeys fallback
  const partByKey = new Map(allParts.map(p => [p.key, p]));
  const columnOrderPref = db.getPref('column_order', {});
  const deviceOrderPref = db.getPref('device_order', {});

  // Build ordered groups: git columns + this-family custom cols, then apply stored ordering.
  // Custom columns are scoped to the family they were added in (family='' means all families).
  const groups = cfg.groups.map(g => {
    const gitCols = g.parts || cfg.parts.map(p => p.key);
    const familyCustomKeys = new Set(db.listCustomPartsForFamily(g.id).map(p => p.key));
    const extra = allParts.filter(p => familyCustomKeys.has(p.key) && !gitCols.includes(p.key)).map(p => p.key);
    let cols = [...gitCols, ...extra];
    const storedOrder = columnOrderPref[g.id];
    if (storedOrder && storedOrder.length) {
      const orderMap = new Map(storedOrder.map((k, i) => [k, i]));
      const defaultIdx = new Map(cols.map((k, i) => [k, i]));
      cols = [...cols].sort((a, b) => {
        const ai = orderMap.has(a) ? orderMap.get(a) : 10000 + (defaultIdx.get(a) || 0);
        const bi = orderMap.has(b) ? orderMap.get(b) : 10000 + (defaultIdx.get(b) || 0);
        return ai - bi;
      });
    }
    return { ...g, parts: cols };
  });

  const colsByGroup = new Map(groups.map(g => [g.id, g.parts]));
  const allKeys = allParts.map(p => p.key);

  // Sort devices within each family by stored order
  const origDevices = effectiveDevices(cfg).filter(d => d.enabled);
  const origIdx = new Map(origDevices.map((d, i) => [d.name, i]));
  const groupOrder = new Map(cfg.groups.map((g, i) => [g.id, i]));
  const devices = [...origDevices].sort((a, b) => {
    const ga = groupOrder.has(a.group) ? groupOrder.get(a.group) : 9999;
    const gb = groupOrder.has(b.group) ? groupOrder.get(b.group) : 9999;
    if (ga !== gb) return ga - gb;
    const ao = deviceOrderPref[a.group] || [];
    const ai = ao.indexOf(a.name);
    const bi = ao.indexOf(b.name);
    if (ai === -1 && bi === -1) return origIdx.get(a.name) - origIdx.get(b.name);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  const rows = devices.map(d => {
    const cells = {};
    const keys = colsByGroup.get(d.group) || allKeys;
    for (const part of keys.map(k => partByKey.get(k)).filter(Boolean)) {
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
      const ref4w = best ? (asOf.get(`${d.name}|${part.key}|${best.source}`) ?? null) : null;
      cells[part.key] = best
        ? {
            price: best.price, source: best.source, url: best.url, title: best.title,
            ts: best.ts, prev: best.prev, ref4w, manual: Boolean(manual),
            alt: offers.filter(o => o !== best).map(o => ({ source: o.source, price: o.price })),
            pinned: pinned.get(`${d.name}|${part.key}`) || null,
          }
        : {
            price: null, source: null, ts: miss ? miss.ts : null,
            title: miss ? miss.matched_title : null, url: miss ? miss.url : null,
            pinned: pinned.get(`${d.name}|${part.key}`) || null,
          };
    }
    return { device: d.name, group: d.group, cells };
  });

  const store = req.query.store ? db.getStore(clean(req.query.store)) : null;
  if (store) {
    const c = storeOut(store).calculator;
    // Per-store retail overrides (right-click → Edit → Retail) win over the calculation.
    const overrides = new Map(db.listManualRetail(store.id).map(r => [`${r.device}|${r.part}|${r.grade}`, r.price]));
    for (const row of rows) {
      for (const key of Object.keys(row.cells)) {
        const cell = row.cells[key];
        const g = partByKey.get(key) && partByKey.get(key).graded ? grade : '';
        const ov = overrides.get(`${row.device}|${key}|${g}`);
        if (ov != null) { cell.retail = ov; cell.retailManual = true; }
        else cell.retail = cell.price == null ? null : calc.computeRetail(cell.price, c, row.group, key);
      }
    }
  }

  // Build flags map: "device|part" → [{flag, note}] — all stores see the same flags.
  const flagsMap = {};
  for (const f of db.listFlags()) {
    const k = `${f.device}|${f.part}`;
    if (!flagsMap[k]) flagsMap[k] = [];
    flagsMap[k].push({ flag: f.flag, note: f.note });
  }

  res.json({
    grade,
    grades: cfg.grades.list,
    groups,
    parts: allParts.map(p => ({ key: p.key, label: p.label.replace('{grade}', grade), graded: p.graded || false, custom: p.custom || false })),
    sources: cfg.sources.filter(s => s.enabled).map(s => ({ key: s.key, label: s.label })),
    site: cfg.site,
    schedule: cfg.schedule,
    rows,
    flags: flagsMap,
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
    webhook: Boolean(WEBHOOK_SECRET),
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function start() {
  // AWAIT the first git sync. On a cold container the volume is empty, so there is no
  // config/*.yml to read until the fetch lands — starting without waiting meant the
  // process exited before its own clone finished, forever.
  await gitsync.start(() => { config.invalidate(); config.get(); });

  let cfg = null;
  for (let attempt = 1; attempt <= 6 && !cfg; attempt++) {
    try {
      cfg = config.get();
    } catch (e) {
      console.error(`[boot] config not readable yet (attempt ${attempt}/6): ${e.message}`);
      if (attempt === 6) {
        console.error('FATAL: could not load config from', config.CONFIG_DIR, '— giving up so the container restarts and retries.');
        console.error('       Check network/DNS to github.com from this container, and GIT_REMOTE/GIT_BRANCH.');
        process.exit(1);
      }
      await sleep(10000);
      await gitsync.pull();     // transient network/DNS on a NAS that just booted
      config.invalidate();
    }
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
