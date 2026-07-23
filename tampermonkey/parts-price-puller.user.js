// CP
// ==UserScript==
// @name         Parts Price Puller
// @namespace    https://github.com/THVjQ
// @version      2.0.1
// @description  Pulls logged-in CrazyParts wholesale prices into the self-hosted SOS pricing site
// @author       THVjQ
// @homepageURL  https://github.com/THVjQ/parts-price-puller
// @supportURL   https://github.com/THVjQ/parts-price-puller/issues
// @updateURL    https://raw.githubusercontent.com/THVjQ/parts-price-puller/main/tampermonkey/parts-price-puller.user.js
// @downloadURL  https://raw.githubusercontent.com/THVjQ/parts-price-puller/main/tampermonkey/parts-price-puller.user.js
// @match        https://crazyparts.com.au/*
// @match        https://www.crazyparts.com.au/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      pricing.thvjq.com.au
// @connect      thvjq.com.au
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  const SCRIPT_VERSION = '2.0.1';
  const DEFAULT_SITE = 'https://pricing.thvjq.com.au';

  // Settings live in GM storage (⚙ button in panel) so script updates never wipe them.
  // v2: these point at the self-hosted site, not Apps Script.
  const getUrl = () => GM_getValue('siteUrl', DEFAULT_SITE);
  const getKey = () => GM_getValue('ingestKey', '');
  // Which grade new pins belong to. Only the graded columns (LCD/OLED) use it — the
  // server decides, from parts.yml `graded:`. Empty = whatever settings.yml says.
  const getGrade = () => GM_getValue('grade', '');

  // Repair common paste mistakes: missing scheme, trailing slash, a pasted /api path.
  function cleanSiteUrl(u) {
    u = String(u || '').trim().replace(/\s+/g, '');
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u.replace(/\/+$/, '').replace(/\/(api|login)(\/.*)?$/i, '');
  }

  // ═══════════════════════ EDIT ME ═══════════════════════
  //
  // CrazyParts is a Next.js (App Router) storefront — products are fetched by a
  // React Server Action, NOT rendered into the HTML. A search is:
  //     POST https://www.crazyparts.com.au/
  //     headers: Accept: text/x-component
  //              Content-Type: text/plain;charset=UTF-8
  //              Next-Action: <CP_SEARCH_ACTION>
  //              Next-Router-State-Tree: <CP_STATE_TREE>
  //     body:    ["<query>", <page>, <pageSize>]     e.g. ["iphone 6s lcd",1,20]
  // The response is an RSC stream containing {"products":[{..,"variants":[{..}]}]}.
  // Each variant carries the logged-in wholesale price in member_price.price
  // (the "+GST" price you see on the tile).
  //
  // ⚠ CP_SEARCH_ACTION is tied to the site's current build and WILL change when
  // CrazyParts redeploys their frontend. When CP suddenly returns NO MATCH again:
  //   1. Open crazyparts.com.au (logged in) → DevTools → Network → Fetch/XHR
  //   2. Search anything in the site's own search box
  //   3. Click the POST to "/" whose response is text/x-component with products
  //   4. Copy the "Next-Action" request header value → paste below.
  // (The state tree rarely changes; refresh it the same way if needed.)
  const CP_SEARCH_ACTION = '704b975d6057afa591a7ded065387da6e10b829c47';
  const CP_STATE_TREE = '%5B%22%22%2C%7B%22children%22%3A%5B%22(site)%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C16%5D';

  const SITE_DEFS = {
    'crazyparts.com.au': {
      key: 'CP',
      mode: 'rsc',                                   // Next.js server-action JSON, not HTML
      fetchProducts: cpFetchProducts,
      searchPageUrl: q => `${location.origin}/products/search/${encodeURIComponent(q)}`, // human link for notes
    },
  };
  // ═════════════════════ END EDIT ME ═════════════════════

  const host = location.hostname.replace(/^www\./, '');
  const SITE = SITE_DEFS[host];
  if (!SITE) return;

  let CONFIG = null;
  let running = false;
  let abortFlag = false;

  // ---------------- Site comms ----------------
  // The site authenticates machines with the X-Key header (INGEST_KEY). GM_xmlhttpRequest
  // is cross-origin by design here, so no CORS dance and no site login cookie is needed.
  function api(method, path, body) {
    return new Promise((resolve, reject) => {
      if (!getUrl() || !getKey()) return reject(new Error('Not configured — click ⚙ Settings'));
      GM_xmlhttpRequest({
        method,
        url: getUrl() + path,
        headers: { 'Content-Type': 'application/json', 'X-Key': getKey() },
        data: body ? JSON.stringify(body) : undefined,
        onload: r => {
          let json;
          try { json = JSON.parse(r.responseText); }
          catch (e) { return reject(new Error('HTTP ' + r.status + ' — not JSON: ' + String(r.responseText).slice(0, 200))); }
          if (r.status >= 400) return reject(new Error(json.error || ('HTTP ' + r.status)));
          resolve(json);
        },
        onerror: () => reject(new Error('Network error — is the site reachable, and is it in @connect?')),
        ontimeout: () => reject(new Error('Timed out')),
        timeout: 60000,
      });
    });
  }
  const getConfig   = () => api('GET', '/api/config');
  const postPrices  = results => api('POST', '/api/ingest', { source: SITE.key, origin: 'tm', results });
  const postLog     = message => api('POST', '/api/log', { site: SITE.key, origin: 'tm', message }).catch(() => {});
  const postAddPin  = pin => api('POST', '/api/pins', Object.assign({ source: SITE.key, origin: 'tm' }, pin));
  const postRemovePin = (device, part, grade) => api('DELETE', '/api/pins', { device, part, grade, source: SITE.key });

  // ---------------- Debug: raw request + diagnosis ----------------
  // Hits /api/config exactly like a real call but returns the untouched response
  // (status, content-type, body) so a bad key / wrong host / login redirect is visible.
  function rawTest(out) {
    if (!getUrl() || !getKey()) { out('❌ Not configured. Click ⚙ Settings and enter the site URL + ingest key first.'); return; }
    const realUrl = getUrl() + '/api/config';
    out('⏳ GET ' + realUrl + '\n(X-Key: ***)\n…');
    GM_xmlhttpRequest({
      method: 'GET', url: realUrl,
      headers: { 'Content-Type': 'application/json', 'X-Key': getKey() },
      onload: r => {
        const ct = (String(r.responseHeaders || '').match(/content-type:[^\r\n]*/i) || ['content-type: (none)'])[0].trim();
        const finalUrl = r.finalUrl || '(unknown)';
        const body = String(r.responseText || '');
        let verdict;
        if (r.status === 401) {
          verdict = '⚠ 401 — the site rejected the key. It must match INGEST_KEY in the server .env exactly (no quotes, no spaces).';
        } else if (/\/login/.test(finalUrl) || /<form[^>]*loginbox|Sign in/i.test(body)) {
          verdict = '⚠ Got the login page. The URL is right but /api/config was not reached — check you pasted the site root (no /login, no trailing path).';
        } else if (/^\s*</.test(body)) {
          verdict = '⚠ Got HTML, not JSON. Usually the wrong host, or a Cloudflare error page in front of the site.';
        } else {
          try {
            const j = JSON.parse(body);
            verdict = j.error
              ? '⚠ Site replied with an error: ' + j.error
              : `✅ Connected — ${(j.devices || []).length} devices, ${(j.partLabels || []).length} parts, ${(j.pins || []).length} pins. If a pull still fails it is matching, not connectivity.`;
          } catch (e) { verdict = '⚠ Response is neither HTML nor valid JSON: ' + e.message; }
        }
        out(
          'HTTP ' + r.status + ' ' + (r.statusText || '') + '\n' +
          'final URL: ' + finalUrl + '\n' +
          ct + '\n' +
          '────────────\n' + verdict + '\n────────────\n' +
          body.slice(0, 1200) + (body.length > 1200 ? '\n…(' + body.length + ' bytes total)' : '')
        );
      },
      onerror:   r => out('❌ Network error (is @connect allowed / URL reachable?)\n' + JSON.stringify(r).slice(0, 300)),
      ontimeout: () => out('❌ Timed out after 60s.'),
      timeout: 60000,
    });
  }

  // ---------------- Debug: capture a real search ----------------
  // Runs one CrazyParts server-action search in your logged-in session and shows
  // what parsed, so you can tell connectivity problems from matching problems.
  function captureSearch(query, out) {
    out('⏳ CrazyParts server-action search (logged-in):\n["' + query + '",1,20]\n…');
    SITE.fetchProducts(query, 20).then(items => {
      const lines = items.slice(0, 12).map(it => '  $' + it.price + '  ' + it.title.slice(0, 60));
      out(
        'products parsed: ' + items.length + '\n' +
        (lines.length ? lines.join('\n') + '\n' : '') +
        (items.length
          ? '✅ Server action works. If a cell is still NO MATCH it is a keyword/model filter (Config tab), not connectivity.'
          : '⚠ 0 products. Usually the Next-Action id changed after a CrazyParts redeploy — re-capture it (see EDIT ME block), or you are not logged in.')
      );
    }).catch(e => out('❌ ' + e.message + '\n(If this is a parse error the RSC format may have changed — send me a capture.)'));
  }

  // ---------------- Matching engine ----------------
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9+ ]/g, ' ').replace(/\s+/g, ' ').trim();

  function deviceTokens(device) {
    return norm(device.search).split(' ').filter(Boolean);
  }

  // Reject titles that are a *bigger* model (e.g. searching "iPhone 12" matching "iPhone 12 Pro Max")
  const MODEL_SUFFIXES = ['pro', 'max', 'plus', 'ultra', 'mini', 'fe', 'e'];
  // Whole-word test — so "plus" does NOT match inside the brand "AMPLUS", and
  // "pro" does NOT match inside "protection". Non-alphanumerics are word breaks.
  const hasWord = (hay, t) => new RegExp('(^|[^a-z0-9])' + escapeRe(t) + '($|[^a-z0-9])').test(hay);
  function titleMatchesDevice(titleN, device) {
    const toks = deviceTokens(device);
    for (const t of toks) if (!hasWord(titleN, t)) return false;
    const devN = norm(device.search);
    const model = lastModelToken(devN);
    if (model !== ' ') {
      // Suffix-run the device carries after its model number, e.g. "pro max", "ultra", "fe", or none.
      const dw = devN.split(' '), mi = dw.indexOf(model), devSuf = [];
      if (mi >= 0) for (let k = mi + 1; k < dw.length; k++) { if (MODEL_SUFFIXES.includes(dw[k])) devSuf.push(dw[k]); else break; }
      // The title must mention this model with the SAME suffix-run somewhere. That lets a
      // "13 / 13 mini" multi-fit part match "iPhone 13", but blocks "13 Pro Max" or "13 mini".
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
      // "S22+" glued-plus: a base device must not match the plus product.
      if (!devN.includes('+') && !devSuf.includes('plus') && new RegExp('\\b' + escapeRe(model) + '\\+').test(titleN)) return false;
    }
    if (device.aliases) {
      const al = device.aliases.split(';').map(norm).filter(Boolean);
      if (al.some(a => titleN.includes(a))) return true;
    }
    return true;
  }
  const lastNumToken = s => (s.match(/\d+[a-z]*/g) || ['\u0000']).pop();
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Last device token that contains a digit — "s22" (not "22"), "12" for "iphone 12" —
  // so the word boundary before it lands right for both Samsung and iPhone naming.
  const lastModelToken = s => { const t = s.split(' ').filter(x => /\d/.test(x)); return t.length ? t[t.length - 1] : ' '; };

  // Hardcoded safeguard: things that are never a phone screen/part module, killed on
  // EVERY search regardless of config/parts.yml — films, polarizers, stencils, packs,
  // lens-only glass, tools, etc. So even out-of-date YAML still gets clean results.
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

  // ---------------- CrazyParts: Next.js server-action search ----------------
  // Returns a normalised candidate list [{title, price, url}] from the RSC JSON.
  async function cpFetchProducts(query, maxResults) {
    const res = await fetch(location.origin + '/', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'text/x-component',
        'Content-Type': 'text/plain;charset=UTF-8',
        'Next-Action': CP_SEARCH_ACTION,
        'Next-Router-State-Tree': CP_STATE_TREE,
      },
      body: JSON.stringify([query, 1, Math.max(maxResults || 20, 6)]),
    });
    // HTTP-level failure: 403/429/503 usually means Cloudflare is rate-limiting or challenging.
    if (!res.ok) {
      const blocked = res.status === 403 || res.status === 429 || res.status === 503;
      const err = new Error('CrazyParts request failed: HTTP ' + res.status + (blocked ? ' — likely a Cloudflare block / rate limit. Solve the check in a normal tab, then retry.' : ''));
      if (blocked) err.cpBlocked = true;
      throw err;
    }
    const txt = await res.text();
    // A valid search returns an RSC (text/x-component) stream. If we instead get an HTML
    // document or a Cloudflare interstitial, the search action didn't run — surface it clearly
    // instead of silently returning "NO MATCH" for every pin.
    if (/^\s*</.test(txt) || /just a moment|challenge-platform|cf-mitigated|attention required/i.test(txt)) {
      const err = new Error('CrazyParts returned an HTML/Cloudflare page instead of product data — either a Cloudflare challenge (solve it in a normal tab, then retry) or a stale CP_SEARCH_ACTION id after a site rebuild (see the constant near the top of this script).');
      err.cpBlocked = true;
      throw err;
    }
    const products = parseRscProducts(txt);
    const out = [];
    for (const p of products) {
      const variants = Array.isArray(p.variants) && p.variants.length ? p.variants : [p];
      for (const v of variants) {
        const price = cpVariantPrice(v);
        if (price === null) continue;
        out.push({
          title: v.name || p.name || '',
          price,
          productId: p.id != null ? String(p.id) : '',
          variantId: v.id != null ? String(v.id) : '',
          url: location.origin + '/products/detail/' + (p.id != null ? p.id : '') + (v.id != null ? '?variant_id=' + v.id : ''),
        });
      }
    }
    return out;
  }

  // Logged-in wholesale price = member_price.price; fall back through ex-tax fields.
  function cpVariantPrice(v) {
    const cands = [
      v && v.member_price && v.member_price.price,
      v && v.unit_price_ex_tax,
      v && v.origin_price,
      v && v.sold_price,
    ];
    for (const x of cands) if (typeof x === 'number' && x > 0) return x;
    return null;
  }

  // Pull the {"products":[...]} array out of a Next.js RSC (text/x-component) stream.
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
  // Extract a balanced [...] / {...} substring, respecting strings + escapes.
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

  async function searchOne(device, q, grade, maxResults) {
    const query = (q.template.replace('{device}', device.search).replace('{grade}', grade || '')).trim();
    const candidates = await SITE.fetchProducts(query, maxResults);

    let best = null;
    for (const it of candidates) {
      const titleN = norm(it.title);
      if (!it.title || it.price === null || it.price === undefined) continue;
      if (!titleMatchesDevice(titleN, device) || !keywordCheck(titleN, q)) continue;
      if (!best || it.price < best.price) best = { price: it.price, title: it.title, url: it.url };
    }
    const fallbackUrl = SITE.searchPageUrl ? SITE.searchPageUrl(query) : location.origin;
    return { device: device.name, part: q.part, price: best ? best.price : null, title: best ? best.title : 'NO MATCH — query: ' + query, url: best ? best.url : fallbackUrl };
  }

  // ---------------- Pull run (PIN-DRIVEN) ----------------
  // Only cells you've pinned in Setup Mode get priced. For each pin we re-fetch the exact
  // product/variant by its stable id and write its CURRENT price. Unpinned cells are left
  // untouched — no fuzzy matching, so nothing wrong is ever written.
  async function runPull(statusFn) {
    if (running) return;
    running = true; abortFlag = false;
    try {
      statusFn('Fetching config…');
      CONFIG = await getConfig();
      if (CONFIG.error) throw new Error(CONFIG.error);
      const pins = CONFIG.pins || [];
      const rateLimitMs = CONFIG.rateLimitMs;
      if (!pins.length) { statusFn('No pins yet — turn on 📌 Setup Mode and pin items on the site.'); return; }

      let done = 0, batch = [], written = 0;
      for (const pin of pins) {
        if (abortFlag) throw new Error('Aborted');
        statusFn(`[${++done}/${pins.length}] ${pin.device} — ${pin.part}`);
        try {
          const found = await fetchPinPrice(pin);
          batch.push({
            device: pin.device, part: pin.part, grade: pin.grade || '',
            price: found ? found.price : null,
            title: found ? found.title : 'PIN NOT FOUND — ' + (pin.title || pin.productId),
            url: found ? found.url : '',
          });
        } catch (e) {
          batch.push({ device: pin.device, part: pin.part, grade: pin.grade || '', price: null, title: 'ERROR: ' + e.message, url: '' });
          // Cloudflare block / stale action id: every remaining pin would fail the same way and
          // keep hammering the wall. Stop now and surface the reason instead of grinding through.
          if (e && e.cpBlocked) {
            if (batch.length) { const r = await postPrices(batch); written += r.written || 0; batch = []; }
            statusFn('⛔ Stopped — ' + e.message);
            postLog('Pull stopped early (blocked): ' + e.message);
            return;
          }
        }
        if (batch.length >= 40) { const r = await postPrices(batch); written += r.written || 0; batch = []; }
        await sleep(rateLimitMs || 900);
      }
      if (batch.length) { const r = await postPrices(batch); written += r.written || 0; }
      GM_setValue('lastRun_' + SITE.key, Date.now());
      statusFn(`✅ Done — ${written}/${pins.length} pinned prices written`);
      postLog(`Pull complete, ${written} written from ${pins.length} pins`);
    } catch (e) {
      statusFn('❌ ' + e.message);
      postLog('Pull failed: ' + e.message);
    } finally {
      running = false;
    }
  }

  // Re-locate a pinned product and read its current price. We search with the pinned title
  // as a seed, then match on the STABLE ids (variant first, then product) — never on text —
  // so the same physical item is priced every run even if its title wording drifts.
  async function fetchPinPrice(pin) {
    const seed = pin.title || pin.device || '';
    const candidates = await searchProducts(seed, 24);
    let m = pin.variantId && candidates.find(c => c.variantId && String(c.variantId) === String(pin.variantId));
    if (!m) m = candidates.find(c => String(c.productId) === String(pin.productId));
    return m ? { price: m.price, title: m.title, url: m.url } : null;
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Session cache for searches so re-opening the same product / seed is instant, and so the
  // modal and a later pull don't both pay for the same lookup. 5-minute TTL.
  const searchCache = new Map();
  // Guard so a Setup-Mode mouse sweep across tiles can't fire many prefetch server-actions
  // at once — at most one prefetch is in flight (real clicks still fetch on demand).
  let prefetchBusy = false;
  function searchProducts(seed, n) {
    const key = String(seed).toLowerCase().trim() + '|' + n;
    const hit = searchCache.get(key);
    if (hit && Date.now() - hit.t < 300000) return hit.p;   // shared promise → dedupes a hover+click
    const p = SITE.fetchProducts(seed, n).catch(e => { searchCache.delete(key); throw e; });
    searchCache.set(key, { t: Date.now(), p });
    return p;
  }

  // ---------------- Scheduled auto-run (only works while a tab is open) ----------------
  async function scheduleCheck() {
    try {
      if (running || !getUrl() || !getKey()) return;
      if (!CONFIG) CONFIG = await getConfig().catch(() => null);
      if (!CONFIG || CONFIG.error) return;
      const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const now = new Date();
      if (days[now.getDay()] !== CONFIG.scheduleDay) return;
      if (now.getHours() < (CONFIG.scheduleHour ?? 0)) return;
      const last = GM_getValue('lastRun_' + SITE.key, 0);
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      if (last >= todayStart) return; // already ran today
      ui.status('⏰ Scheduled pull starting…');
      runPull(ui.status);
    } catch (_) { /* silent */ }
  }

  // ---------------- Setup Mode: pin exact products from the site ----------------
  let setupMode = GM_getValue('setupMode', false);
  let pinObserver = null;
  let pinModalEl = null;

  function setSetupMode(on) {
    setupMode = on;
    GM_setValue('setupMode', on);
    document.documentElement.classList.toggle('ppp-setup', on);
    if (on) { ensureConfig().then(decorateAllTiles); startTileObserver(); }
    else { stopTileObserver(); clearTileButtons(); closePinModal(); }
  }

  async function ensureConfig() {
    if (!CONFIG || !CONFIG.partLabels) { try { CONFIG = await getConfig(); } catch (e) { CONFIG = CONFIG || {}; } }
    return CONFIG;
  }

  // Tag each product tile (found by its detail link) with a 📌 button.
  function decorateAllTiles() {
    if (!setupMode) return;
    document.querySelectorAll('a[href*="/products/detail/"]').forEach(a => {
      const card = a.closest('li, article, [class*="card" i], [class*="product" i], [class*="item" i]') || a.parentElement;
      if (!card || card.classList.contains('ppp-carded')) return;
      card.classList.add('ppp-carded');
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
      const btn = document.createElement('button');
      btn.className = 'ppp-pin-btn'; btn.type = 'button'; btn.textContent = '📌 Pin';
      btn.title = 'Pin this product to a price cell';
      btn.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); openPinModal(a, card); });
      // Warm the search cache while the pointer is on the button, so the click feels instant.
      let preTimer;
      btn.addEventListener('mouseenter', () => { preTimer = setTimeout(() => {
        if (prefetchBusy) return;                      // one prefetch at a time — no burst
        const t = tileInfo(a, card).title;
        if (!t) return;
        prefetchBusy = true;
        searchProducts(t, 12).catch(() => {}).finally(() => { prefetchBusy = false; });
      }, 120); });
      btn.addEventListener('mouseleave', () => clearTimeout(preTimer));
      card.appendChild(btn);
    });
  }
  function clearTileButtons() {
    document.querySelectorAll('.ppp-pin-btn').forEach(b => b.remove());
    document.querySelectorAll('.ppp-carded').forEach(c => c.classList.remove('ppp-carded'));
  }
  let decorateTimer = null;
  function startTileObserver() {
    if (pinObserver) return;
    // Debounce: the storefront mutates the DOM constantly; re-scanning on every mutation
    // lags the page. Coalesce bursts into one scan 250ms after things settle.
    pinObserver = new MutationObserver(() => {
      if (!setupMode) return;
      clearTimeout(decorateTimer);
      decorateTimer = setTimeout(decorateAllTiles, 250);
    });
    pinObserver.observe(document.body, { childList: true, subtree: true });
  }
  function stopTileObserver() { if (pinObserver) { pinObserver.disconnect(); pinObserver = null; } }

  // Best-guess product title + id off the tile — a search seed and a match hint.
  const stripBtn = s => String(s || '').replace(/📌\s*Pin|✓\s*Pinned/g, '');
  // Walk up to the smallest ancestor that looks like a real product tile (contains an image).
  function getCard(anchor, fallback) {
    let el = anchor.parentElement;
    for (let i = 0; i < 6 && el && el !== document.body; i++) { if (el.querySelector && el.querySelector('img')) return el; el = el.parentElement; }
    return anchor.closest('li, article') || fallback || anchor.parentElement || anchor;
  }
  function tileInfo(anchor, card) {
    const idMatch = (anchor.getAttribute('href') || '').match(/\/products\/detail\/([^/?#]+)/);
    const tc = getCard(anchor, card);
    const clean = s => stripBtn(s).replace(/\s+/g, ' ').trim();
    let title = '';
    // 1) longest product-link text (the NAME link, not the image link we hung the button on)
    tc.querySelectorAll('a[href*="/product"]').forEach(l => { const t = clean(l.textContent); if (t.length > title.length) title = t; });
    // 2) product image alt — tiles almost always put the product name here
    if (!title) { const img = tc.querySelector('img[alt]'); if (img) title = clean(img.getAttribute('alt')); }
    // 3) the clicked link's own title / aria-label attribute
    if (!title) title = clean(anchor.getAttribute('title') || anchor.getAttribute('aria-label') || '');
    // 4) any heading / title-ish element in the tile
    if (!title) { const h = tc.querySelector('h1,h2,h3,h4,[class*="title" i],[class*="name" i]'); if (h) title = clean(h.textContent); }
    return { hintId: idMatch ? idMatch[1] : '', title: title.slice(0, 120) };
  }

  const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Pick the MOST specific device in the title, so "iPhone 11 Pro Max" beats "iPhone 11".
  function preselectDevice(sel, title) {
    const t = (title || '').toLowerCase();
    let best = '';
    for (const o of sel.options) { const v = (o.value || '').toLowerCase(); if (v && t.includes(v) && v.length > best.length) best = v; }
    if (best) for (const o of sel.options) if ((o.value || '').toLowerCase() === best) { sel.value = o.value; return o.value; }
    return sel.value;
  }
  // Guess the part column from the title (order matters — most specific first).
  const PART_HINTS = [
    ['BACK_GLASS', /back glass|rear glass|back cover|battery cover/],
    ['CAM_REAR', /rear camera|back camera|main camera/],
    ['CAM_FRONT', /front camera|selfie/],
    ['BAT_SP', /battery service pack/],
    ['BAT_AM', /battery/],
    ['SP', /service pack/],
    ['REFURB', /refurb/],
    ['OLED', /oled|amoled/],
    ['LCD', /lcd|incell|screen|display|assembly/],
  ];
  const detectPart = title => { const t = (title || '').toLowerCase(); for (const [k, re] of PART_HINTS) if (re.test(t)) return k; return ''; };
  const GRADES = ['incell', 'hard oled', 'soft oled', 'bq7', 'amp', 'oem', 'genuine', 'aftermarket'];
  const detectGrade = title => { const t = (title || '').toLowerCase(); return GRADES.find(g => t.includes(g)) || ''; };
  function closePinModal() { if (pinModalEl) { pinModalEl.remove(); pinModalEl = null; } }

  // ---- Background pin queue: click Pin → dialog closes instantly, saving happens up top ----
  const pinQueue = [];
  let pinWorking = false, pinTotal = 0, pinDone = 0, pinFail = 0, toastHideTimer = null;

  function ensureToast() {
    let t = document.getElementById('ppp-toast');
    if (!t) {
      t = document.createElement('div'); t.id = 'ppp-toast';
      t.innerHTML = '<div class="ppp-toast-msg"></div><div class="ppp-toast-bar"><i></i></div>';
      document.body.appendChild(t);
    }
    return t;
  }
  function updatePinToast() {
    const t = ensureToast();
    const pending = pinTotal - pinDone - pinFail;
    t.querySelector('.ppp-toast-msg').textContent = pending > 0
      ? '📌 Pinning… ' + (pinDone + pinFail) + '/' + pinTotal + (pinFail ? ' (' + pinFail + ' failed)' : '')
      : '✅ Pinned ' + pinDone + '/' + pinTotal + (pinFail ? ' · ' + pinFail + ' failed' : '');
    t.querySelector('.ppp-toast-bar i').style.width = (pinTotal ? Math.round((pinDone + pinFail) / pinTotal * 100) : 0) + '%';
    clearTimeout(toastHideTimer);
    if (pending <= 0) toastHideTimer = setTimeout(() => { t.remove(); pinTotal = pinDone = pinFail = 0; }, 3500);
  }
  function enqueuePin(pin, cardBtn) { pinTotal++; pinQueue.push({ pin, cardBtn }); updatePinToast(); runPinQueue(); }
  async function runPinQueue() {
    if (pinWorking) return;
    pinWorking = true;
    while (pinQueue.length) {
      const { pin, cardBtn } = pinQueue.shift();
      try {
        const r = await postAddPin(pin);
        if (r && r.error) throw new Error(r.error);
        pinDone++;
        if (cardBtn) { cardBtn.textContent = '✓ Pinned'; cardBtn.classList.add('done'); }
      } catch (e) {
        pinFail++;
        if (cardBtn) { cardBtn.textContent = '⚠ Retry'; cardBtn.classList.remove('done'); }
      }
      updatePinToast();
    }
    pinWorking = false;
    updatePinToast();
  }

  // Modal: auto-detects device + part from the tile, lists the EXACT product/variant options
  // (real search results, best match on top), and pins your choice.
  async function openPinModal(anchor, card) {
    closePinModal();
    const info = tileInfo(anchor, card);
    const el = document.createElement('div');
    el.className = 'ppp-modal';
    el.innerHTML =
      '<div class="ppp-modal-box"><div class="ppp-modal-hd">📌 Pin product to a price cell' +
      '<span class="ppp-modal-x">✕</span></div><div class="ppp-modal-bd">' +
      '<label>Device (row)</label><select class="ppp-m-device"></select>' +
      '<label>Part (column)</label><select class="ppp-m-part"></select>' +
      '<label>Search products (edit if wrong, then Enter)</label>' +
      '<div class="ppp-seed-row"><input class="ppp-m-seed" placeholder="e.g. iphone 11 lcd"><button class="ppp-m-research sec">🔍</button></div>' +
      '<label>Exact product &amp; variant — the price you will track</label>' +
      '<div class="ppp-cands">Loading…</div>' +
      '<div class="ppp-modal-status"></div>' +
      '<button class="ppp-m-save" disabled>Pin this product</button>' +
      '<button class="ppp-m-cancel sec">Cancel</button></div></div>';
    document.body.appendChild(el);
    pinModalEl = el;

    const devSel = el.querySelector('.ppp-m-device');
    const partSel = el.querySelector('.ppp-m-part');
    const seedInput = el.querySelector('.ppp-m-seed');
    const candsEl = el.querySelector('.ppp-cands');
    const statusEl = el.querySelector('.ppp-modal-status');
    const saveBtn = el.querySelector('.ppp-m-save');
    let chosen = null, candidates = [], showAll = false;

    el.querySelector('.ppp-modal-x').onclick = closePinModal;
    el.querySelector('.ppp-m-cancel').onclick = closePinModal;
    el.addEventListener('click', ev => { if (ev.target === el) closePinModal(); });

    // Serve config from cache for an instant modal — only hit the network if we don't have it
    // yet (Setup Mode + the panel both prefetch it, so this is usually already warm).
    if (!(CONFIG && CONFIG.devices && CONFIG.devices.length && (CONFIG.partLabels || CONFIG.parts))) {
      try { const c = await getConfig(); if (c && !c.error) CONFIG = c; } catch (e) { /* keep any cached */ }
      if (!pinModalEl) return; // user closed it while we awaited
    }
    const devices = (CONFIG && CONFIG.devices) || [];
    const parts = (CONFIG && CONFIG.partLabels) || (((CONFIG && CONFIG.parts) || []).map(k => ({ key: k, label: k })));
    if (!devices.length || !parts.length) {
      statusEl.textContent = '⚠ Config empty — check ⚙ Settings, and that config/devices.yml + parts.yml loaded on the site (Status panel).';
    }
    const activeGrade = getGrade() || (CONFIG && CONFIG.grade) || '';
    devices.forEach(d => devSel.add(new Option(d.name, d.name)));
    parts.forEach(p => partSel.add(new Option(String(p.label || p.key).replace('{grade}', activeGrade), p.key)));
    preselectDevice(devSel, info.title);              // auto model
    const partGuess = detectPart(info.title);          // auto type
    if (partGuess) partSel.value = partGuess;
    // Seed the (editable) search box — detected title, else "device + part".
    seedInput.value = info.title || ((devSel.value || '') + ' ' + (partGuess || '')).trim();

    // Rank matches: the tile's own product first, then title contains device + grade, then cheapest.
    function renderCandidates() {
      const devV = (devSel.value || '').toLowerCase(), gradeGuess = detectGrade(seedInput.value);
      const score = c => { let s = 0; const t = (c.title || '').toLowerCase();
        if (info.hintId && c.productId === info.hintId) s += 1000;
        if (devV && t.includes(devV)) s += 20;
        if (gradeGuess && t.includes(gradeGuess)) s += 8; return s; };
      candidates.sort((a, b) => score(b) - score(a) || a.price - b.price);
      // Show ONLY the product you clicked (its variants) — no clutter. "Show all" reveals the rest.
      let list = candidates, filtered = false;
      if (info.hintId && !showAll) {
        const only = candidates.filter(c => c.productId === info.hintId);
        if (only.length) { list = only; filtered = true; }
      }
      candsEl.innerHTML = ''; chosen = null;
      list.forEach(c => {
        const row = document.createElement('label');
        row.className = 'ppp-cand';
        row.innerHTML = '<input type="radio" name="ppp-cand"><span>$' + c.price + '</span> <em>' + escapeHtml(c.title) + '</em>';
        row.querySelector('input').addEventListener('change', () => { chosen = c; saveBtn.disabled = false; });
        candsEl.appendChild(row);
      });
      const top = candsEl.querySelector('input');       // auto-select the clicked product / best match
      if (top) { top.checked = true; chosen = list[0]; saveBtn.disabled = false; }
      if (filtered && candidates.length > list.length) {
        const more = document.createElement('button');
        more.className = 'sec'; more.textContent = 'Show all ' + candidates.length + ' results';
        more.style.cssText = 'margin-top:6px';
        more.onclick = () => { showAll = true; renderCandidates(); };
        candsEl.appendChild(more);
      }
    }

    async function doSearch() {
      const seed = (seedInput.value || '').trim();
      if (!seed) { candsEl.textContent = 'Type what to search for above.'; return; }
      candsEl.textContent = 'Searching “' + seed + '” …'; saveBtn.disabled = true;
      const t0 = Date.now();
      try { candidates = await searchProducts(seed, 12); }
      catch (e) { candsEl.textContent = '❌ ' + e.message; return; }
      if (!pinModalEl) return;
      if (!candidates.length) candsEl.textContent = '⚠ No products — check you are logged in, or edit the search above and press Enter.';
      else { renderCandidates(); statusEl.textContent = candidates.length + ' results in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's'; }
    }
    el.querySelector('.ppp-m-research').onclick = doSearch;
    seedInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); doSearch(); } });
    devSel.addEventListener('change', () => { if (candidates.length) renderCandidates(); }); // re-sort on model change
    doSearch();

    saveBtn.onclick = () => {
      if (!chosen) { statusEl.textContent = 'Pick the exact product/variant first.'; return; }
      if (!devSel.value || !partSel.value) { statusEl.textContent = 'Choose a device and a part first.'; return; }
      // Queue it and close immediately — saving runs in the background (progress bar up top),
      // so you can jump straight to pinning the next product.
      const cardBtn = card.querySelector('.ppp-pin-btn');
      if (cardBtn) cardBtn.textContent = '⏳ Pinning';
      enqueuePin({
        device: devSel.value, part: partSel.value, grade: activeGrade,
        productId: chosen.productId, variantId: chosen.variantId,
        title: chosen.title, price: chosen.price, url: chosen.url,
      }, cardBtn);
      closePinModal();
    };
  }

  // ---------------- UI panel ----------------
  const ui = buildPanel();
  if (setupMode) setSetupMode(true);
  setInterval(scheduleCheck, 5 * 60 * 1000);
  setTimeout(scheduleCheck, 15000);

  function buildPanel() {
    const el = document.createElement('div');
    el.id = 'ppp-root';
    el.innerHTML = `
      <style>
        /* Floating launcher button — bottom-LEFT */
        #ppp-fab{position:fixed;bottom:16px;left:16px;z-index:1000000;width:52px;height:52px;
          border-radius:50%;background:#e94560;color:#fff;border:0;cursor:pointer;font-size:22px;
          box-shadow:0 4px 16px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;
          transition:transform .12s}
        #ppp-fab:hover{transform:scale(1.08)}
        /* Panel opens above the button, anchored bottom-LEFT, hidden until opened */
        #ppp-panel{position:fixed;bottom:78px;left:16px;z-index:1000000;background:#16213e;color:#e0e0e0;
          font:12px/1.5 monospace;border:1px solid #0f3460;border-radius:8px;width:270px;
          box-shadow:0 4px 20px rgba(0,0,0,.5);display:none;max-height:82vh;overflow:auto}
        #ppp-panel.open{display:block}
        #ppp-panel .hd{padding:6px 10px;background:#0f3460;border-radius:8px 8px 0 0;
          font-weight:bold;display:flex;justify-content:space-between;position:sticky;top:0}
        #ppp-panel .hd .x{cursor:pointer}
        #ppp-panel .bd{padding:10px}
        #ppp-panel button{background:#e94560;color:#fff;border:0;border-radius:4px;padding:6px 10px;
          cursor:pointer;font:inherit;width:100%;margin-top:6px}
        #ppp-panel button.sec{background:#0f3460}
        #ppp-panel button:disabled{opacity:.5;cursor:default}
        #ppp-panel select{width:100%;background:#1a1a2e;color:#e0e0e0;border:1px solid #0f3460;
          border-radius:4px;padding:4px;font:inherit}
        #ppp-status{margin-top:8px;min-height:32px;word-break:break-word;color:#a0c4ff}
        #ppp-panel label{display:block;margin-top:6px;color:#888}
        #ppp-panel details{margin-top:10px;border-top:1px solid #0f3460;padding-top:6px}
        #ppp-panel summary{cursor:pointer;color:#f0a500;font-weight:bold;user-select:none}
        #ppp-debug{margin-top:6px;background:#0d1117;border:1px solid #0f3460;border-radius:4px;
          padding:6px;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;
          font-size:11px;color:#9fe6a0;display:none}
        #ppp-debug.show{display:block}
        /* ── Setup Mode: on-tile pin buttons + assignment modal (global, not scoped) ── */
        .ppp-pin-btn{position:absolute;top:6px;right:6px;z-index:999999;background:#f0a500;
          color:#1a1a2e;border:0;border-radius:4px;padding:3px 7px;font:bold 12px/1 monospace;
          cursor:pointer;box-shadow:0 1px 6px rgba(0,0,0,.4)}
        .ppp-pin-btn.done{background:#79d279}
        html.ppp-setup #ppp-fab{outline:3px solid #f0a500}
        .ppp-modal{position:fixed;inset:0;z-index:1000001;background:rgba(0,0,0,.55);
          display:flex;align-items:center;justify-content:center}
        .ppp-modal-box{background:#16213e;color:#e0e0e0;font:13px/1.5 monospace;width:min(460px,92vw);
          max-height:88vh;overflow:auto;border:1px solid #0f3460;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.6)}
        .ppp-modal-hd{padding:8px 12px;background:#0f3460;font-weight:bold;display:flex;
          justify-content:space-between;border-radius:8px 8px 0 0}
        .ppp-modal-x{cursor:pointer}
        .ppp-modal-bd{padding:12px}
        .ppp-modal-bd label{display:block;margin:8px 0 2px;color:#888}
        .ppp-modal-bd select{width:100%;background:#1a1a2e;color:#e0e0e0;border:1px solid #0f3460;
          border-radius:4px;padding:5px;font:inherit}
        .ppp-seed{color:#a0c4ff;margin-bottom:4px;word-break:break-word}
        .ppp-seed-row{display:flex;gap:6px}
        .ppp-m-seed{flex:1;background:#1a1a2e;color:#e0e0e0;border:1px solid #0f3460;
          border-radius:4px;padding:5px;font:inherit}
        .ppp-m-research{width:auto!important;margin-top:0!important;padding:5px 10px!important}
        .ppp-cands{max-height:210px;overflow:auto;border:1px solid #0f3460;border-radius:4px;
          padding:4px;margin-top:2px}
        .ppp-cand{display:flex;gap:6px;align-items:center;padding:4px;border-radius:3px;cursor:pointer}
        .ppp-cand:hover{background:#0d1a33}
        .ppp-cand span{color:#79d279;font-weight:bold;min-width:56px}
        .ppp-cand em{font-style:normal;color:#cfe0ff}
        .ppp-modal-bd button{background:#e94560;color:#fff;border:0;border-radius:4px;padding:8px 10px;
          cursor:pointer;font:inherit;width:100%;margin-top:8px}
        .ppp-modal-bd button.sec{background:#0f3460}
        .ppp-modal-bd button:disabled{opacity:.5;cursor:default}
        .ppp-modal-status{margin-top:8px;color:#a0c4ff;min-height:18px;word-break:break-word}
        /* Top progress bar for background pinning */
        #ppp-toast{position:fixed;top:0;left:0;right:0;z-index:1000002;background:#0f3460;color:#fff;
          font:12px/1.4 monospace;padding:6px 12px 0;box-shadow:0 2px 10px rgba(0,0,0,.4)}
        #ppp-toast .ppp-toast-msg{text-align:center;padding-bottom:4px}
        #ppp-toast .ppp-toast-bar{height:3px;background:rgba(255,255,255,.15);border-radius:2px;overflow:hidden}
        #ppp-toast .ppp-toast-bar i{display:block;height:100%;background:#79d279;width:0;transition:width .25s}
      </style>
      <button id="ppp-fab" title="Parts Price Puller">💰</button>
      <div id="ppp-panel">
        <div class="hd"><span>💰 Price Puller v${SCRIPT_VERSION}</span><span class="x" id="ppp-close">✕</span></div>
        <div class="bd">
          <label>Grade (which LCD/OLED column pins land in)</label>
          <select id="ppp-grade"></select>
          <button id="ppp-setup" class="sec">📌 Setup Mode: OFF</button>
          <button id="ppp-pull">▶ Pull pinned prices (${host})</button>
          <button id="ppp-abort" class="sec">■ Abort</button>
          <button id="ppp-open" class="sec">🔗 Open pricing site</button>
          <button id="ppp-settings" class="sec">⚙ Settings (site URL + key)</button>
          <div id="ppp-status">Idle. Site: ${SITE.key}</div>
          <details id="ppp-debugbox">
            <summary>🐛 Debug</summary>
            <button id="ppp-test" class="sec">Test connection (raw)</button>
            <button id="ppp-capture" class="sec">Capture search HTML</button>
            <button id="ppp-info" class="sec">Show current settings</button>
            <button id="ppp-copy" class="sec">Copy debug output</button>
            <div id="ppp-debug"></div>
          </details>
        </div>
      </div>`;
    document.body.appendChild(el);

    const panel   = el.querySelector('#ppp-panel');
    const statusEl = el.querySelector('#ppp-status');
    const debugEl  = el.querySelector('#ppp-debug');
    const status = msg => { statusEl.textContent = msg; };
    const debug  = msg => { debugEl.classList.add('show'); debugEl.textContent = msg; };

    el.querySelector('#ppp-fab').onclick   = () => panel.classList.toggle('open');
    el.querySelector('#ppp-close').onclick = () => panel.classList.remove('open');

    el.querySelector('#ppp-pull').onclick = () => runPull(status);
    el.querySelector('#ppp-abort').onclick = () => { abortFlag = true; };

    const setupBtn = el.querySelector('#ppp-setup');
    function reflectSetup() {
      setupBtn.textContent = '📌 Setup Mode: ' + (setupMode ? 'ON' : 'OFF');
      setupBtn.style.background = setupMode ? '#f0a500' : '';
      setupBtn.style.color = setupMode ? '#1a1a2e' : '';
    }
    setupBtn.onclick = () => {
      setSetupMode(!setupMode); reflectSetup();
      status(setupMode ? 'Setup Mode ON — browse the site and click 📌 Pin on any product.' : 'Setup Mode off.');
    };
    reflectSetup();
    el.querySelector('#ppp-test').onclick = () => { el.querySelector('#ppp-debugbox').open = true; debug('Running…'); rawTest(debug); };
    el.querySelector('#ppp-capture').onclick = () => {
      const q = prompt('Search query to capture (do this while logged in):', 'iphone 12 lcd');
      if (q === null) return;
      el.querySelector('#ppp-debugbox').open = true; debug('Capturing…'); captureSearch(q.trim(), debug);
    };
    el.querySelector('#ppp-info').onclick = () => {
      const u = getUrl(), k = getKey();
      debug(
        'Script version: ' + SCRIPT_VERSION + '\n' +
        'Supplier: ' + SITE.key + ' (' + host + ')\n' +
        'Pricing site: ' + (u || '(none)') + '\n' +
        'Ingest key: ' + (k ? 'set, ' + k.length + ' chars, ends …' + k.slice(-4) : '⚠ NOT SET') + '\n' +
        'Grade for new pins: ' + (getGrade() || '(site default)') + '\n' +
        'Endpoints: GET /api/config · POST /api/ingest · POST/DELETE /api/pins'
      );
    };
    el.querySelector('#ppp-copy').onclick = () => {
      const t = debugEl.textContent || '';
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject())
        .then(() => status('Debug output copied.'))
        .catch(() => status('Copy failed — select the text manually.'));
    };
    el.querySelector('#ppp-open').onclick = () => { if (getUrl()) window.open(getUrl(), '_blank', 'noopener'); };

    el.querySelector('#ppp-settings').onclick = () => {
      const u = prompt('Pricing site URL (root, no trailing path):', getUrl());
      if (u === null) return;
      const k = prompt('Ingest key (matches INGEST_KEY in the site\'s .env):', getKey());
      if (k === null) return;
      const cleanUrl = cleanSiteUrl(u);
      GM_setValue('siteUrl', cleanUrl);
      GM_setValue('ingestKey', k.trim());
      CONFIG = null;
      status(cleanUrl && k.trim() ? 'Saved: ' + cleanUrl : '⚠ Not configured');
      loadGrade();
    };

    // The grade is a LOCAL choice: it decides which per-grade column a pin lands in.
    // It is not pushed anywhere — the site's default grade lives in config/settings.yml.
    el.querySelector('#ppp-grade').onchange = e => {
      GM_setValue('grade', e.target.value);
      status('New pins will go to the ' + e.target.value + ' column.');
    };

    function loadGrade() {
      if (!getUrl() || !getKey()) { status('⚠ Not configured — click ⚙ Settings'); return; }
      getConfig().then(c => {
        if (!c || c.error) return status('⚠ ' + ((c && c.error) || 'no config'));
        CONFIG = c;
        const sel = el.querySelector('#ppp-grade');
        const list = c.grades && c.grades.length ? c.grades : [c.grade];
        sel.innerHTML = '';
        list.forEach(g => sel.add(new Option(g, g)));
        const want = getGrade() || c.grade;
        sel.value = list.includes(want) ? want : c.grade;
        GM_setValue('grade', sel.value);
        status(`Connected — ${(c.devices || []).length} devices, ${(c.pins || []).length} pins. Grade: ${sel.value}`);
      }).catch(e => status('⚠ ' + e.message));
    }
    loadGrade();
    return { status };
  }
})();
