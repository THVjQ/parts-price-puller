/**
 * Parts Price Puller — Willard scheduled scraper v2.0.0
 *
 * Logs into CrazyParts with Playwright and pushes prices to the SELF-HOSTED site
 * (pricing.thvjq.com.au). No Google Apps Script anywhere.
 *
 * Config — devices, parts, queries, pins, schedule, rate limits — comes from
 * GET {SITE_URL}/api/config, which the web app renders from config/*.yml. That keeps
 * one YAML parser in one place: edit the YAML in git, the web app reloads it, and the
 * next scraper tick sees the change without a redeploy.
 *
 * Pull order:
 *   1. PINS  — every pinned cell is re-priced from its exact product/variant id.
 *   2. QUERY — only if PULL_UNPINNED=1: remaining cells get the old fuzzy search.
 *      Off by default, because fuzzy matching is what the pin workflow replaced.
 *
 * ENV (see .env.example): SITE_URL, INGEST_KEY, CP_USER, CP_PASS, TZ,
 *                         RUN_NOW=1, PULL_UNPINNED=1
 */
const { chromium } = require('playwright');

const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');
const INGEST_KEY = process.env.INGEST_KEY || '';
const PULL_UNPINNED = process.env.PULL_UNPINNED === '1';

if (!SITE_URL || !INGEST_KEY) {
  console.error('FATAL: SITE_URL and INGEST_KEY must be set (see .env.example).');
  process.exit(1);
}

// ═══════════════ EDIT ME — per site ═══════════════
//
// CrazyParts (mode 'rsc') is a Next.js App Router storefront. Products are NOT in
// the HTML; a search is a React Server Action:
//     POST https://www.crazyparts.com.au/
//     headers Next-Action: <CP_SEARCH_ACTION>, Accept: text/x-component,
//             Content-Type: text/plain;charset=UTF-8, Next-Router-State-Tree: <tree>
//     body    ["<query>", <page>, <pageSize>]
// Response is an RSC stream with {"products":[{..,"variants":[{member_price:{price}}]}]}.
//
// ⚠ CP_SEARCH_ACTION is build-specific and changes when CrazyParts redeploys their
//   frontend. Refresh it from DevTools → Network → Fetch/XHR → the POST to "/" →
//   copy the "Next-Action" request header. (Keep it in sync with the userscript.)
//
const CP_SEARCH_ACTION = '704b975d6057afa591a7ded065387da6e10b829c47';
const CP_STATE_TREE = '%5B%22%22%2C%7B%22children%22%3A%5B%22(site)%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C16%5D';

const SITES = [
  {
    key: 'CP',
    mode: 'rsc',
    base: 'https://www.crazyparts.com.au',
    loginUrl: 'https://www.crazyparts.com.au/login',
    user: process.env.CP_USER, pass: process.env.CP_PASS,
    userSel: 'input[type="email"], input[name="email"], #email, #username',
    passSel: 'input[type="password"], input[name="password"], #password',
    submitSel: 'button[type="submit"]',
    loggedInSel: 'a[href*="account"], a[href*="logout"], [class*="account"]',
    searchAction: CP_SEARCH_ACTION, stateTree: CP_STATE_TREE,
    searchPageUrl: q => `https://www.crazyparts.com.au/products/search/${encodeURIComponent(q)}`,
  },
];
// ═════════════════════ END EDIT ME ═════════════════════

// ---------------- CrazyParts RSC parsing (mirror of userscript) ----------------
function cpVariantPrice(v) {
  const cands = [
    v && v.member_price && v.member_price.price,
    v && v.unit_price_ex_tax, v && v.origin_price, v && v.sold_price,
  ];
  for (const x of cands) if (typeof x === 'number' && x > 0) return x;
  return null;
}
function extractBalanced(s, start, open, close) {
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < s.length; j++) {
    const ch = s[j];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return s.slice(start, j + 1); }
  }
  return null;
}
function parseRscProducts(txt) {
  const KEY = '"products":';
  let i = txt.indexOf(KEY);
  while (i !== -1) {
    const arrStart = txt.indexOf('[', i);
    if (arrStart !== -1) {
      const arr = extractBalanced(txt, arrStart, '[', ']');
      if (arr) { try { const p = JSON.parse(arr); if (Array.isArray(p) && p.length) return p; } catch (e) { /* keep scanning */ } }
    }
    i = txt.indexOf(KEY, i + 1);
  }
  return [];
}
// Run the CrazyParts server-action search inside the logged-in page.
// Returns [{title, price, url, productId, variantId}] — the ids are what pin re-pricing
// matches on, so a pinned cell tracks the same physical item even if its title drifts.
async function cpFetchProducts(page, site, query, maxResults) {
  const res = await page.evaluate(async ({ action, tree, query, n }) => {
    const r = await fetch('/', {
      method: 'POST', credentials: 'include',
      headers: {
        'Accept': 'text/x-component',
        'Content-Type': 'text/plain;charset=UTF-8',
        'Next-Action': action,
        'Next-Router-State-Tree': tree,
      },
      body: JSON.stringify([query, 1, n]),
    });
    return { status: r.status, ok: r.ok, text: await r.text() };
  }, { action: site.searchAction, tree: site.stateTree, query, n: Math.max(maxResults || 20, 20) });

  if (!res.ok) {
    const err = new Error(`CrazyParts HTTP ${res.status}` + ([403, 429, 503].includes(res.status) ? ' — Cloudflare block / rate limit' : ''));
    err.cpBlocked = [403, 429, 503].includes(res.status);
    throw err;
  }
  if (/^\s*</.test(res.text) || /just a moment|challenge-platform|cf-mitigated|attention required/i.test(res.text)) {
    const err = new Error('CrazyParts returned HTML/Cloudflare instead of product data — challenge, or a stale CP_SEARCH_ACTION after a site rebuild');
    err.cpBlocked = true;
    throw err;
  }

  const out = [];
  for (const p of parseRscProducts(res.text)) {
    const variants = Array.isArray(p.variants) && p.variants.length ? p.variants : [p];
    for (const v of variants) {
      const price = cpVariantPrice(v);
      if (price === null) continue;
      out.push({
        title: v.name || p.name || '', price,
        productId: p.id != null ? String(p.id) : '',
        variantId: v.id != null ? String(v.id) : '',
        url: site.base + '/products/detail/' + (p.id != null ? p.id : '') + (v.id != null ? '?variant_id=' + v.id : ''),
      });
    }
  }
  return out;
}

// ---------------- Site API ----------------
async function api(method, path, body) {
  const res = await fetch(SITE_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Key': INGEST_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new Error(`${method} ${path} → HTTP ${res.status}, not JSON: ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`${method} ${path} → ${json.error || res.status}`);
  return json;
}
const getConfig = () => api('GET', '/api/config');
const postPrices = (source, results) => api('POST', '/api/ingest', { source, origin: 'willard', results });
const postLog = (site, message) => api('POST', '/api/log', { origin: 'willard', site, message }).catch(() => {});

// ---------------- Matching (unpinned/fuzzy path only) ----------------
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9+ ]/g, ' ').replace(/\s+/g, ' ').trim();
const MODEL_SUFFIXES = ['pro', 'max', 'plus', 'ultra', 'mini', 'fe', 'e'];
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whole-word test — so "plus" does NOT match inside "AMPLUS", "pro" not inside "protection".
const hasWord = (hay, t) => new RegExp('(^|[^a-z0-9])' + escapeRe(t) + '($|[^a-z0-9])').test(hay);
// Last device token that contains a digit — "s22" (not "22") — so the boundary lands right.
const lastModelToken = s => { const t = s.split(' ').filter(x => /\d/.test(x)); return t.length ? t[t.length - 1] : ' '; };
function titleMatchesDevice(titleN, device) {
  const toks = norm(device.search).split(' ').filter(Boolean);
  for (const t of toks) if (!hasWord(titleN, t)) return false;
  const devN = norm(device.search);
  const model = lastModelToken(devN);
  if (model !== ' ') {
    const dw = devN.split(' '), mi = dw.indexOf(model), devSuf = [];
    if (mi >= 0) for (let k = mi + 1; k < dw.length; k++) { if (MODEL_SUFFIXES.includes(dw[k])) devSuf.push(dw[k]); else break; }
    // Title must mention the model with the SAME suffix-run somewhere: lets "13 / 13 mini"
    // multi-fit parts match "iPhone 13", but blocks "13 Pro Max" and "13 mini".
    const words = titleN.split(' ');
    let sawModel = false, okModel = false;
    for (let i = 0; i < words.length && !okModel; i++) {
      if (words[i] !== model) continue;
      sawModel = true;
      const run = [];
      for (let k = i + 1; k < words.length; k++) { if (MODEL_SUFFIXES.includes(words[k])) run.push(words[k]); else break; }
      if (run.length === devSuf.length && run.every((s, idx) => s === devSuf[idx])) okModel = true;
    }
    if (sawModel && !okModel) return false;
    if (!devN.includes('+') && !devSuf.includes('plus') && new RegExp('\\b' + escapeRe(model) + '\\+').test(titleN)) return false; // "s22+"
  }
  if (Array.isArray(device.aliases) && device.aliases.length) {
    const al = device.aliases.map(norm).filter(Boolean);
    if (al.some(a => titleN.includes(a))) return true;
  }
  return true;
}
// Hardcoded safeguard — never a phone screen/part module; killed on every search
// regardless of the YAML, so an out-of-date parts.yml still gets clean results.
const GLOBAL_EXCLUDE = [
  'stencil', 'mould', 'mold', 'alignment', 'polarizer', 'film', 'filter', 'pack of',
  'laminating', 'oca', 'mesh', 'backlight', 'flex protection', 'blue light', 'bead',
  'camera lens', 'lens replacement', 'lens for', 'jig', 'tester', 'remover', 'sticker',
  'template', 'fixture', 'positioning', 'screen protector', 'tempered glass',
  'protection film', 'uv glue', 'tweezer', 'brush', 'cleaning', 'tool kit', 'repair tool',
  'sponge', 'engraving', 'dummy', 'sample', 'keychain',
];
function keywordCheck(titleN, q) {
  if (GLOBAL_EXCLUDE.some(k => titleN.includes(k))) return false;
  const must = q.match ? q.match.split(';').map(norm).filter(Boolean) : [];
  const excl = q.exclude ? q.exclude.split(';').map(norm).filter(Boolean) : [];
  // A must-keyword matches when EVERY word in it is present (not necessarily adjacent),
  // so "lcd assembly" still matches real titles like "LCD Screen Assembly".
  const phraseIn = (t, phrase) => phrase.split(' ').every(w => t.includes(w));
  if (must.length && !must.some(k => phraseIn(titleN, k))) return false;
  if (excl.some(k => titleN.includes(k))) return false;
  return true;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------- Login ----------------
async function login(browser, site) {
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36' });
  const page = await ctx.newPage();
  await page.goto(site.loginUrl, { waitUntil: 'domcontentloaded' });

  if (!(await page.$(site.loggedInSel))) {
    await page.fill(site.userSel, site.user);
    await page.fill(site.passSel, site.pass);
    await Promise.all([page.waitForLoadState('domcontentloaded'), page.click(site.submitSel)]);
    await sleep(2000);
    if (!(await page.$(site.loggedInSel))) {
      await postLog(site.key, 'LOGIN FAILED — check selectors/credentials');
      await ctx.close();
      return null;
    }
  }
  return { ctx, page };
}

// ---------------- Pass 1: pinned cells (the normal path) ----------------
// Re-locate each pinned product by its stable ids and read its CURRENT price. We search
// with the pinned title as a seed, then match on variantId (then productId) — never on
// text — so the same physical item is priced every run.
async function pullPins(page, site, cfg, pins) {
  let done = 0, batch = [], written = 0;
  for (const pin of pins) {
    done++;
    try {
      const candidates = await cpFetchProducts(page, site, pin.title || pin.device, 24);
      let m = pin.variantId && candidates.find(c => c.variantId && c.variantId === String(pin.variantId));
      if (!m) m = candidates.find(c => c.productId === String(pin.productId));
      batch.push({
        device: pin.device, part: pin.part, grade: pin.grade || '',
        price: m ? m.price : null,
        title: m ? m.title : 'PIN NOT FOUND — ' + (pin.title || pin.productId),
        url: m ? m.url : '',
      });
    } catch (e) {
      batch.push({ device: pin.device, part: pin.part, grade: pin.grade || '', price: null, title: 'ERROR: ' + e.message.slice(0, 160), url: '' });
      // A block hits every remaining pin the same way — stop instead of hammering.
      if (e.cpBlocked) {
        if (batch.length) written += (await postPrices(site.key, batch)).written || 0;
        await postLog(site.key, 'Pull stopped early (blocked): ' + e.message);
        console.error('[' + site.key + '] STOPPED —', e.message);
        return { written, stopped: true };
      }
    }
    if (done % 20 === 0) console.log(`[${site.key}] pins ${done}/${pins.length}`);
    if (batch.length >= 40) { written += (await postPrices(site.key, batch)).written || 0; batch = []; }
    await sleep(cfg.rateLimitMs || 900);
  }
  if (batch.length) written += (await postPrices(site.key, batch)).written || 0;
  return { written, stopped: false };
}

// ---------------- Pass 2: unpinned cells, fuzzy (opt-in) ----------------
async function pullUnpinned(page, site, cfg, pinnedKeys) {
  const total = cfg.devices.length * cfg.queries.length;
  let done = 0, batch = [], written = 0;
  for (const device of cfg.devices) {
    for (const q of cfg.queries) {
      done++;
      if (pinnedKeys.has(device.name + '|' + q.part)) continue;   // never fuzz over a pin
      const grade = q.graded ? (cfg.grade || '') : '';
      const query = q.template.replace('{device}', device.search).replace('{grade}', grade).trim();
      try {
        const candidates = await cpFetchProducts(page, site, query, cfg.maxResults || 20);
        let best = null;
        for (const it of candidates.slice(0, cfg.maxResults || 12)) {
          const titleN = norm(it.title);
          if (!it.title || it.price == null) continue;
          if (!titleMatchesDevice(titleN, device) || !keywordCheck(titleN, q)) continue;
          if (!best || it.price < best.price) best = it;
        }
        batch.push({
          device: device.name, part: q.part, grade,
          price: best ? best.price : null,
          title: best ? best.title : 'NO MATCH — query: ' + query,
          url: best ? best.url : site.searchPageUrl(query),
        });
      } catch (e) {
        batch.push({ device: device.name, part: q.part, grade, price: null, title: 'ERROR: ' + e.message.slice(0, 160), url: '' });
        if (e.cpBlocked) {
          if (batch.length) written += (await postPrices(site.key, batch)).written || 0;
          await postLog(site.key, 'Unpinned pass stopped (blocked): ' + e.message);
          return { written, stopped: true };
        }
      }
      if (done % 25 === 0) console.log(`[${site.key}] fuzzy ${done}/${total}`);
      if (batch.length >= 40) { written += (await postPrices(site.key, batch)).written || 0; batch = []; }
      await sleep(cfg.rateLimitMs || 900);
    }
  }
  if (batch.length) written += (await postPrices(site.key, batch)).written || 0;
  return { written, stopped: false };
}

async function scrapeSite(browser, site, cfg) {
  console.log(`[${site.key}] login…`);
  const session = await login(browser, site);
  if (!session) { console.error(`[${site.key}] LOGIN FAILED`); return; }
  const { ctx, page } = session;
  console.log(`[${site.key}] logged in`);

  try {
    const pins = (cfg.pins || []).filter(p => !p.source || p.source === site.key);
    let written = 0, stopped = false;

    if (pins.length) {
      console.log(`[${site.key}] ${pins.length} pinned cells`);
      const r = await pullPins(page, site, cfg, pins);
      written += r.written; stopped = r.stopped;
    } else {
      console.log(`[${site.key}] no pins`);
    }

    if (!stopped && PULL_UNPINNED) {
      const pinnedKeys = new Set(pins.map(p => p.device + '|' + p.part));
      const r = await pullUnpinned(page, site, cfg, pinnedKeys);
      written += r.written;
    }

    if (!pins.length && !PULL_UNPINNED) {
      await postLog(site.key, 'Scheduled run: nothing to do — no pins, and PULL_UNPINNED is off');
    } else if (!stopped) {
      await postLog(site.key, `Scheduled pull complete — ${written} prices written`);
    }
    console.log(`[${site.key}] done — ${written} written`);
  } finally {
    await ctx.close();
  }
}

async function runAll() {
  console.log('=== PULL START', new Date().toISOString(), '===');
  let cfg;
  try { cfg = await getConfig(); }
  catch (e) { console.error('Config fetch failed:', e.message); return; }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const site of SITES) {
      if (!site.user || !site.pass) { console.log(`[${site.key}] skipped — no credentials`); continue; }
      await scrapeSite(browser, site, cfg);
    }
  } finally {
    await browser.close();
  }
  console.log('=== PULL END ===');
}

// ---------------- Scheduler: day/hour read live from config/settings.yml ----------------
let lastRunDate = '';
async function tick() {
  try {
    const cfg = await getConfig();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (days[now.getDay()] === cfg.scheduleDay && now.getHours() >= (cfg.scheduleHour ?? 0) && lastRunDate !== today) {
      lastRunDate = today;
      await runAll();
    }
  } catch (e) { console.error('tick error:', e.message); }
}

(async () => {
  if (process.env.RUN_NOW === '1') await runAll();
  console.log(`Scheduler active — checking every 10 min. site=${SITE_URL} TZ=${process.env.TZ || 'system'} unpinned=${PULL_UNPINNED}`);
  setInterval(tick, 10 * 60 * 1000);
  tick();
})();
