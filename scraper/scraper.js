/**
 * Parts Price Puller — Willard scheduled scraper v1.0.0
 * Logs into both sites with Playwright, runs the same search/match logic,
 * POSTs results to the Apps Script web app. Schedule (day/hour) is read
 * LIVE from the sheet Config tab, so changing it in the sheet just works.
 *
 * ENV (docker-compose.yml): APPS_SCRIPT_URL, API_KEY,
 *   CP_USER, CP_PASS, TPH_USER, TPH_PASS, TZ, RUN_NOW (optional=1)
 */
const { chromium } = require('playwright');

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const API_KEY = process.env.API_KEY;

// ═══════════════ EDIT ME — selectors per site ═══════════════
const SITES = [
  {
    key: 'CP',
    base: 'https://crazyparts.com.au',
    loginUrl: 'https://crazyparts.com.au/my-account/',
    user: process.env.CP_USER, pass: process.env.CP_PASS,
    userSel: '#username', passSel: '#password',
    submitSel: 'button[name="login"], button[type="submit"]',
    loggedInSel: '.woocommerce-MyAccount-navigation, a[href*="logout"]',
    searchUrl: q => `https://crazyparts.com.au/?s=${encodeURIComponent(q)}&post_type=product`,
    item: 'li.product, .product-grid-item, .products .product',
    title: '.woocommerce-loop-product__title, .product-title, h2, h3',
    price: '.price',
    link: 'a.woocommerce-LoopProduct-link, a',
  },
  {
    key: 'TPH',
    base: 'https://thepartshome.com.au',
    loginUrl: 'https://thepartshome.com.au/my-account/',
    user: process.env.TPH_USER, pass: process.env.TPH_PASS,
    userSel: '#username', passSel: '#password',
    submitSel: 'button[name="login"], button[type="submit"]',
    loggedInSel: '.woocommerce-MyAccount-navigation, a[href*="logout"]',
    searchUrl: q => `https://thepartshome.com.au/?s=${encodeURIComponent(q)}&post_type=product`,
    item: 'li.product, .product-grid-item, .products .product',
    title: '.woocommerce-loop-product__title, .product-title, h2, h3',
    price: '.price',
    link: 'a.woocommerce-LoopProduct-link, a',
  },
];
// ═════════════════════ END EDIT ME ═════════════════════

// ---------------- Apps Script comms ----------------
async function api(method, params, body) {
  const url = `${APPS_SCRIPT_URL}?key=${encodeURIComponent(API_KEY)}${params ? '&' + params : ''}`;
  const res = await fetch(url, {
    method, redirect: 'follow',
    headers: { 'Content-Type': 'text/plain' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}
const getConfig = () => api('GET', 'action=config');
const postPrices = (site, results) => api('POST', '', { action: 'prices', site, source: 'willard', results });
const postLog = (site, message) => api('POST', '', { action: 'log', site, source: 'willard', message }).catch(() => {});

// ---------------- Matching (mirror of TM script) ----------------
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9+ ]/g, ' ').replace(/\s+/g, ' ').trim();
const MODEL_SUFFIXES = ['pro', 'max', 'plus', 'ultra', 'mini', 'fe', 'e'];
const lastNumToken = s => (s.match(/\d+[a-z]*/g) || ['\u0000']).pop();
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function titleMatchesDevice(titleN, device) {
  const toks = norm(device.search).split(' ').filter(Boolean);
  for (const t of toks) if (!titleN.includes(t)) return false;
  const devN = norm(device.search);
  for (const suf of MODEL_SUFFIXES) {
    if (!devN.includes(' ' + suf) && new RegExp('\\b' + escapeRe(lastNumToken(devN)) + '\\s+' + suf + '\\b').test(titleN)) return false;
  }
  if (device.aliases) {
    const al = device.aliases.split(';').map(norm).filter(Boolean);
    if (al.some(a => titleN.includes(a))) return true;
  }
  return true;
}
function keywordCheck(titleN, q) {
  const must = q.match ? q.match.split(';').map(norm).filter(Boolean) : [];
  const excl = q.exclude ? q.exclude.split(';').map(norm).filter(Boolean) : [];
  if (must.length && !must.some(k => titleN.includes(k))) return false;
  if (excl.some(k => titleN.includes(k))) return false;
  return true;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------- Scrape one site ----------------
async function scrapeSite(browser, site, cfg) {
  console.log(`[${site.key}] login…`);
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36' });
  const page = await ctx.newPage();
  await page.goto(site.loginUrl, { waitUntil: 'domcontentloaded' });

  if (!(await page.$(site.loggedInSel))) {
    await page.fill(site.userSel, site.user);
    await page.fill(site.passSel, site.pass);
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      page.click(site.submitSel),
    ]);
    await sleep(2000);
    if (!(await page.$(site.loggedInSel))) {
      await postLog(site.key, 'LOGIN FAILED — check selectors/credentials');
      console.error(`[${site.key}] LOGIN FAILED`);
      await ctx.close();
      return;
    }
  }
  console.log(`[${site.key}] logged in`);

  const total = cfg.devices.length * cfg.queries.length;
  let done = 0, batch = [];
  for (const device of cfg.devices) {
    for (const q of cfg.queries) {
      done++;
      const query = q.template.replace('{device}', device.search).replace('{grade}', cfg.grade || '').trim();
      try {
        await page.goto(site.searchUrl(query), { waitUntil: 'domcontentloaded', timeout: 45000 });
        const items = await page.$$eval(site.item, (els, sel) =>
          els.slice(0, 15).map(el => {
            const t = el.querySelector(sel.title);
            const p = el.querySelector(sel.price);
            const pi = p && p.querySelector('ins');
            const a = el.querySelector(sel.link);
            return {
              title: t ? t.textContent.trim() : '',
              priceText: p ? (pi || p).textContent : '',
              url: a ? a.href : '',
            };
          }), { title: site.title, price: site.price, link: site.link });

        let best = null;
        for (const it of items.slice(0, cfg.maxResults || 12)) {
          const titleN = norm(it.title);
          if (!it.title || !titleMatchesDevice(titleN, device) || !keywordCheck(titleN, q)) continue;
          const nums = (it.priceText.match(/[\d,]+\.\d{2}|[\d,]+/g) || [])
            .map(n => parseFloat(n.replace(/,/g, ''))).filter(n => !isNaN(n) && n > 0);
          if (!nums.length) continue;
          const price = Math.min(...nums);
          if (!best || price < best.price) best = { price, title: it.title, url: it.url };
        }
        batch.push({
          device: device.name, part: q.part,
          price: best ? best.price : null,
          title: best ? best.title : 'NO MATCH — query: ' + query,
          url: best ? best.url : site.searchUrl(query),
        });
        if (done % 20 === 0) console.log(`[${site.key}] ${done}/${total}`);
        if (batch.length >= 40) { await postPrices(site.key, batch); batch = []; }
      } catch (e) {
        batch.push({ device: device.name, part: q.part, price: null, title: 'ERROR: ' + e.message.slice(0, 120), url: '' });
      }
      await sleep(cfg.rateLimitMs || 900);
    }
  }
  if (batch.length) await postPrices(site.key, batch);
  await postLog(site.key, `Scheduled pull complete (${total} searches)`);
  console.log(`[${site.key}] done`);
  await ctx.close();
}

async function runAll() {
  console.log('=== PULL START', new Date().toISOString(), '===');
  const cfg = await getConfig();
  if (cfg.error) { console.error('Config error:', cfg.error); return; }
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

// ---------------- Scheduler: reads day/hour live from the sheet ----------------
let lastRunDate = '';
async function tick() {
  try {
    const cfg = await getConfig();
    if (cfg.error) return;
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
  if (process.env.RUN_NOW === '1') { await runAll(); }
  console.log('Scheduler active — checking every 10 min. TZ=' + (process.env.TZ || 'system'));
  setInterval(tick, 10 * 60 * 1000);
  tick();
})();
