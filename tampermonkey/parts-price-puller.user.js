// ==UserScript==
// @name         Parts Price Puller
// @namespace    https://github.com/THVjQ
// @version      1.8.0
// @description  Pulls logged-in CrazyParts wholesale prices into a Google Sheet
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
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  const SCRIPT_VERSION = '1.8.0';

  // Settings live in GM storage (⚙ button in panel) so script updates never wipe them.
  const getUrl = () => GM_getValue('gasUrl', '');
  const getKey = () => GM_getValue('gasKey', '');

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

  // ---------------- Apps Script comms ----------------
  function api(method, params, body) {
    return new Promise((resolve, reject) => {
      if (!getUrl() || !getKey()) return reject(new Error('Not configured — click ⚙ Settings'));
      const url = getUrl() + '?key=' + encodeURIComponent(getKey()) +
        (params ? '&' + params : '');
      GM_xmlhttpRequest({
        method, url,
        headers: { 'Content-Type': 'text/plain' }, // avoids CORS preflight, GAS still parses
        data: body ? JSON.stringify(body) : undefined,
        onload: r => {
          try { resolve(JSON.parse(r.responseText)); }
          catch (e) { reject(new Error('Bad response: ' + r.responseText.slice(0, 200))); }
        },
        onerror: reject, ontimeout: reject, timeout: 60000,
      });
    });
  }
  const getConfig   = () => api('GET', 'action=config');
  const postPrices  = results => api('POST', '', { action: 'prices', site: SITE.key, source: 'tm', results });
  const postGrade   = grade => api('POST', '', { action: 'setGrade', grade, source: 'tm' });
  const postLog     = message => api('POST', '', { action: 'log', site: SITE.key, source: 'tm', message }).catch(() => {});

  // ---------------- Debug: raw request + diagnosis ----------------
  // Hits the web app exactly like a real call but returns the untouched
  // response (status, redirect target, content-type, body) so config
  // problems — especially the "Anyone with Google account" login page — are visible.
  function rawTest(out) {
    if (!getUrl() || !getKey()) { out('❌ Not configured. Click ⚙ Settings and enter your /exec URL + key first.'); return; }
    const shownUrl = getUrl() + '?key=***&action=config';
    const realUrl  = getUrl() + '?key=' + encodeURIComponent(getKey()) + '&action=config';
    out('⏳ GET ' + shownUrl + '\n…');
    GM_xmlhttpRequest({
      method: 'GET', url: realUrl,
      headers: { 'Content-Type': 'text/plain' },
      onload: r => {
        const ct = (String(r.responseHeaders || '').match(/content-type:[^\r\n]*/i) || ['content-type: (none)'])[0].trim();
        const finalUrl = r.finalUrl || '(unknown)';
        const body = String(r.responseText || '');
        const probe = finalUrl + '\n' + body.slice(0, 1000);
        let verdict;
        if (/accounts\.google\.com|ServiceLogin|_/i.test(finalUrl) && /accounts\.google\.com|ServiceLogin/i.test(probe)) {
          verdict = '⚠ REDIRECTED TO GOOGLE LOGIN.\nYour deployment access is "Anyone with Google account".\nFix: Apps Script → Deploy → Manage deployments → ✏️ edit → Who has access = "Anyone" → New version → Deploy.';
        } else if (/^\s*</.test(body)) {
          verdict = '⚠ Got HTML, not JSON. Usually: wrong URL (must end in /exec), a stale deployment, or access not set to "Anyone".';
        } else {
          try { JSON.parse(body); verdict = '✅ Valid JSON — connection is working. If a pull still fails it is a matching/selector issue, not connectivity.'; }
          catch (e) { verdict = '⚠ Response is neither HTML nor valid JSON: ' + e.message; }
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
  // EVERY search regardless of the sheet Config — films, polarizers, stencils, packs,
  // lens-only glass, tools, etc. So even an out-of-date Config still gets clean results.
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
      body: JSON.stringify([query, 1, Math.max(maxResults || 20, 20)]),
    });
    const txt = await res.text();
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

  // ---------------- Pull run ----------------
  async function runPull(statusFn) {
    if (running) return;
    running = true; abortFlag = false;
    try {
      statusFn('Fetching config…');
      CONFIG = await getConfig();
      if (CONFIG.error) throw new Error(CONFIG.error);
      const { devices, queries, grade, rateLimitMs, maxResults } = CONFIG;
      const total = devices.length * queries.length;
      let done = 0, batch = [], written = 0;

      for (const device of devices) {
        for (const q of queries) {
          if (abortFlag) throw new Error('Aborted');
          statusFn(`[${++done}/${total}] ${device.name} — ${q.part}`);
          try {
            batch.push(await searchOne(device, q, grade, maxResults || 12));
          } catch (e) {
            batch.push({ device: device.name, part: q.part, price: null, title: 'ERROR: ' + e.message, url: '' });
          }
          if (batch.length >= 40) {
            const r = await postPrices(batch); written += r.written || 0; batch = [];
          }
          await sleep(rateLimitMs || 900);
        }
      }
      if (batch.length) { const r = await postPrices(batch); written += r.written || 0; }
      GM_setValue('lastRun_' + SITE.key, Date.now());
      statusFn(`✅ Done — ${written} prices written`);
      postLog(`Pull complete, ${written} written`);
    } catch (e) {
      statusFn('❌ ' + e.message);
      postLog('Pull failed: ' + e.message);
    } finally {
      running = false;
    }
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  // ---------------- UI panel ----------------
  const ui = buildPanel();
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
      </style>
      <button id="ppp-fab" title="Parts Price Puller">💰</button>
      <div id="ppp-panel">
        <div class="hd"><span>💰 Price Puller v${SCRIPT_VERSION}</span><span class="x" id="ppp-close">✕</span></div>
        <div class="bd">
          <label>Grade (LCD/OLED queries)</label>
          <select id="ppp-grade">
            <option>AMP</option><option selected>BQ7</option><option>SP</option>
            <option>INCELL</option><option>HARD OLED</option><option>SOFT OLED</option>
          </select>
          <button id="ppp-setgrade" class="sec">Save grade → sheet</button>
          <button id="ppp-pull">▶ Pull all prices (${host})</button>
          <button id="ppp-abort" class="sec">■ Abort</button>
          <button id="ppp-settings" class="sec">⚙ Settings (sheet URL + key)</button>
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
        'Site: ' + SITE.key + ' (' + host + ')\n' +
        'URL set: ' + (u ? u : '(none)') + '\n' +
        'Key set: ' + (k ? 'yes, ' + k.length + ' chars, ends …' + k.slice(-4) : 'NO') + '\n' +
        'Ends in /exec: ' + (/\/exec$/.test(u) ? 'yes' : '⚠ NO — must end in /exec')
      );
    };
    el.querySelector('#ppp-copy').onclick = () => {
      const t = debugEl.textContent || '';
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject())
        .then(() => status('Debug output copied.'))
        .catch(() => status('Copy failed — select the text manually.'));
    };
    el.querySelector('#ppp-settings').onclick = () => {
      const u = prompt('Apps Script Web App URL (ends in /exec):', getUrl());
      if (u === null) return;
      const k = prompt('API key (matches KEY script property):', getKey());
      if (k === null) return;
      GM_setValue('gasUrl', u.trim());
      GM_setValue('gasKey', k.trim());
      CONFIG = null;
      status(u.trim() && k.trim() ? 'Saved. Ready.' : '⚠ Not configured');
      loadGrade();
    };
    el.querySelector('#ppp-setgrade').onclick = async () => {
      const g = el.querySelector('#ppp-grade').value;
      status('Saving grade…');
      try { await postGrade(g); CONFIG = null; status('Grade = ' + g + ' saved. Pull to refresh prices.'); }
      catch (e) { status('❌ ' + e.message); }
    };

    function loadGrade() {
      if (!getUrl() || !getKey()) { status('⚠ Not configured — click ⚙ Settings'); return; }
      getConfig().then(c => {
        if (c && c.grade) {
          CONFIG = c;
          const sel = el.querySelector('#ppp-grade');
          if (![...sel.options].some(o => o.value === c.grade)) sel.add(new Option(c.grade, c.grade));
          sel.value = c.grade;
          status('Connected. Grade: ' + c.grade);
        }
      }).catch(e => status('⚠ ' + e.message));
    }
    loadGrade();
    return { status };
  }
})();
