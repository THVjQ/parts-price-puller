// ==UserScript==
// @name         Parts Price Puller
// @namespace    https://github.com/THVjQ
// @version      1.2.0
// @description  Pulls logged-in part prices from CrazyParts + The Parts Home into Google Sheet
// @author       THVjQ
// @homepageURL  https://github.com/THVjQ/parts-price-puller
// @supportURL   https://github.com/THVjQ/parts-price-puller/issues
// @updateURL    https://raw.githubusercontent.com/THVjQ/parts-price-puller/main/tampermonkey/parts-price-puller.user.js
// @downloadURL  https://raw.githubusercontent.com/THVjQ/parts-price-puller/main/tampermonkey/parts-price-puller.user.js
// @match        https://crazyparts.com.au/*
// @match        https://www.crazyparts.com.au/*
// @match        https://thepartshome.com.au/*
// @match        https://www.thepartshome.com.au/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  const SCRIPT_VERSION = '1.2.0';

  // Settings live in GM storage (⚙ button in panel) so script updates never wipe them.
  const getUrl = () => GM_getValue('gasUrl', '');
  const getKey = () => GM_getValue('gasKey', '');

  // ═══════════════════════ EDIT ME (only if a site changes layout) ═══════════════════════
  // Both sites are WooCommerce-style; if a selector misses,
  // right-click a product tile > Inspect and adjust here.
  const SITE_DEFS = {
    'crazyparts.com.au': {
      key: 'CP',
      searchUrl: q => `${location.origin}/?s=${encodeURIComponent(q)}&post_type=product`,
      item:  'li.product, .product-grid-item, .products .product',
      title: '.woocommerce-loop-product__title, .product-title, h2, h3',
      price: '.price',
      link:  'a.woocommerce-LoopProduct-link, a',
    },
    'thepartshome.com.au': {
      key: 'TPH',
      searchUrl: q => `${location.origin}/?s=${encodeURIComponent(q)}&post_type=product`,
      item:  'li.product, .product-grid-item, .products .product',
      title: '.woocommerce-loop-product__title, .product-title, h2, h3',
      price: '.price',
      link:  'a.woocommerce-LoopProduct-link, a',
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

  // ---------------- Matching engine ----------------
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9+ ]/g, ' ').replace(/\s+/g, ' ').trim();

  function deviceTokens(device) {
    return norm(device.search).split(' ').filter(Boolean);
  }

  // Reject titles that are a *bigger* model (e.g. searching "iPhone 12" matching "iPhone 12 Pro Max")
  const MODEL_SUFFIXES = ['pro', 'max', 'plus', 'ultra', 'mini', 'fe', 'e'];
  function titleMatchesDevice(titleN, device) {
    const toks = deviceTokens(device);
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
  const lastNumToken = s => (s.match(/\d+[a-z]*/g) || ['\u0000']).pop();
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function keywordCheck(titleN, q) {
    const must = q.match ? q.match.split(';').map(norm).filter(Boolean) : [];
    const excl = q.exclude ? q.exclude.split(';').map(norm).filter(Boolean) : [];
    if (must.length && !must.some(k => titleN.includes(k))) return false;
    if (excl.some(k => titleN.includes(k))) return false;
    return true;
  }

  function parsePrice(el) {
    if (!el) return null;
    const ins = el.querySelector('ins');
    const txt = (ins || el).textContent || '';
    const nums = (txt.match(/[\d,]+\.\d{2}|[\d,]+/g) || [])
      .map(n => parseFloat(n.replace(/,/g, ''))).filter(n => !isNaN(n) && n > 0);
    return nums.length ? Math.min(...nums) : null;
  }

  async function searchOne(device, q, grade, maxResults) {
    const query = q.template.replace('{device}', device.search).replace('{grade}', grade || '');
    const url = SITE.searchUrl(query.trim());
    const res = await fetch(url, { credentials: 'include' });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const items = [...doc.querySelectorAll(SITE.item)].slice(0, maxResults);

    let best = null;
    for (const it of items) {
      const titleEl = it.querySelector(SITE.title);
      const title = titleEl ? titleEl.textContent.trim() : '';
      const titleN = norm(title);
      if (!title || !titleMatchesDevice(titleN, device) || !keywordCheck(titleN, q)) continue;
      const price = parsePrice(it.querySelector(SITE.price));
      if (price === null) continue;
      const linkEl = it.querySelector(SITE.link);
      const link = linkEl ? linkEl.href : url;
      if (!best || price < best.price) best = { price, title, url: link };
    }
    return { device: device.name, part: q.part, price: best ? best.price : null, title: best ? best.title : 'NO MATCH — query: ' + query, url: best ? best.url : url };
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
