/* Parts Price Puller — front end.
   Wholesale comes from the server; RETAIL is computed in the browser with the same
   calc.js the server uses, so switching store or dragging a markup slider repaints
   instantly without a round trip. */
(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // ?store=lismore&grade=AMP&view=both overrides the remembered choice, so a staff
  // member can be sent a link straight to their own store's retail column.
  const qs = new URLSearchParams(location.search);
  const state = {
    data: null,
    stores: [],
    storeId: qs.get('store') || localStorage.getItem('ppp.store') || '',
    view: qs.get('view') || localStorage.getItem('ppp.view') || 'wholesale',
    grade: qs.get('grade') || localStorage.getItem('ppp.grade') || '',
    filter: qs.get('q') || '',
    currency: '$',
    gstPercent: 10,
  };

  const store = () => state.stores.find(s => s.id === state.storeId) || null;

  function money(v) {
    if (v == null) return '';
    const s = Number(v).toFixed(2).replace(/\.00$/, '');
    return state.currency + s;
  }
  const ago = iso => {
    if (!iso) return 'never';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 90) return 'just now';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    if (s < 172800) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' days ago';
  };

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { location.href = '/login'; throw new Error('login required'); }
    const json = await res.json().catch(() => ({ error: 'bad response' }));
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  }

  // ───────────────────────────────────────────── load + render
  async function loadStores() {
    const r = await api('GET', '/api/stores');
    state.stores = r.stores;
    const sel = $('#storeSel');
    sel.innerHTML = '<option value="">— wholesale only —</option>';
    r.stores.forEach(s => sel.add(new Option(s.name + (s.edited ? '' : ' (default)'), s.id)));
    if (state.storeId && !store()) state.storeId = '';
    sel.value = state.storeId;
    reflectViewAvailability();
  }

  async function loadMatrix() {
    const q = state.grade ? '?grade=' + encodeURIComponent(state.grade) : '';
    const d = await api('GET', '/api/prices' + q);
    state.data = d;
    state.grade = d.grade;
    state.currency = (d.site && d.site.currency) || '$';
    state.gstPercent = (d.site && d.site.gstPercent) || 0;

    $('#siteTitle').textContent = (d.site && d.site.title) || 'Parts Pricing';
    $('#siteSubtitle').textContent = (d.site && d.site.subtitle) || '';
    document.title = ((d.site && d.site.title) || 'Parts Pricing') + ' — ' + d.grade;

    const gs = $('#gradeSel');
    if (gs.options.length !== d.grades.length) {
      gs.innerHTML = '';
      d.grades.forEach(g => gs.add(new Option(g, g)));
    }
    gs.value = d.grade;

    $('#updated').textContent = 'Prices updated ' + ago(d.updated);
    render();
  }

  function render() {
    const d = state.data;
    if (!d) return;

    // header
    const head = $('#headRow');
    head.innerHTML = '';
    head.appendChild(Object.assign(el('th', 'devcol', 'Device'), { scope: 'col' }));
    d.parts.forEach(p => head.appendChild(Object.assign(el('th', null, p.label), { scope: 'col' })));

    const groups = new Map(d.groups.map(g => [g.id, g.label]));
    const calcCfg = store() ? store().calculator : null;
    const view = calcCfg ? state.view : 'wholesale';

    const body = document.createDocumentFragment();
    let lastGroup = null;

    d.rows.forEach(row => {
      if (row.group !== lastGroup) {
        lastGroup = row.group;
        const tr = el('tr', 'grouprow');
        const th = el('th', null, groups.get(row.group) || row.group);
        th.colSpan = d.parts.length + 1;
        tr.appendChild(th);
        body.appendChild(tr);
      }

      const tr = el('tr');
      tr.dataset.device = row.device.toLowerCase();
      tr.appendChild(el('td', 'devcol', row.device));

      d.parts.forEach(p => {
        const c = row.cells[p.key] || {};
        const td = el('td', 'cell');
        td.dataset.device = row.device;
        td.dataset.part = p.key;

        if (c.price == null) {
          td.classList.add('empty');
          td.textContent = c.ts ? '—' : '';
          if (c.ts) td.dataset.miss = '1';
        } else {
          const retail = calcCfg ? PPPCalc.computeRetail(c.price, calcCfg, state.gstPercent) : null;
          if (c.prev != null && c.prev !== c.price) td.classList.add(c.price > c.prev ? 'up' : 'down');
          if (c.manual) td.classList.add('manual');
          if (c.pinned) td.classList.add('pinned');

          if (view === 'wholesale') {
            td.appendChild(el('span', 'w', money(c.price)));
          } else if (view === 'retail') {
            td.appendChild(el('span', 'r', money(retail)));
          } else {
            td.classList.add('both');
            td.appendChild(el('span', 'w', money(c.price)));
            td.appendChild(el('span', 'r', money(retail)));
          }
        }
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });

    const tbody = $('#body');
    tbody.innerHTML = '';
    tbody.appendChild(body);
    applyFilter();
  }

  function applyFilter() {
    const q = state.filter.trim().toLowerCase();
    let shownInGroup = 0;
    const rows = [...$('#body').children];
    // Walk backwards so a group header can be hidden once we know every row under it
    // filtered out.
    for (let i = rows.length - 1; i >= 0; i--) {
      const tr = rows[i];
      if (tr.classList.contains('grouprow')) {
        tr.classList.toggle('hidden', shownInGroup === 0);
        shownInGroup = 0;
      } else {
        const hit = !q || tr.dataset.device.includes(q);
        tr.classList.toggle('hidden', !hit);
        if (hit) shownInGroup++;
      }
    }
  }

  function reflectViewAvailability() {
    const has = Boolean(store());
    document.querySelectorAll('#viewSeg button').forEach(b => {
      const needsStore = b.dataset.view !== 'wholesale';
      b.disabled = needsStore && !has;
      b.title = needsStore && !has ? 'Pick a store first' : '';
      b.classList.toggle('on', b.dataset.view === (has ? state.view : 'wholesale'));
    });
    $('#calcBtn').disabled = !has;
    $('#calcBtn').title = has ? 'Edit this store’s calculator' : 'Pick a store first';
  }

  // ───────────────────────────────────────────── cell popover
  const pop = $('#pop');
  function closePop() { pop.hidden = true; }

  async function openPop(td) {
    const d = state.data;
    const row = d.rows.find(r => r.device === td.dataset.device);
    if (!row) return;
    const c = row.cells[td.dataset.part];
    const part = d.parts.find(p => p.key === td.dataset.part);
    const calcCfg = store() ? store().calculator : null;

    pop.innerHTML = '';
    pop.appendChild(Object.assign(el('button', 'close', '✕'), { onclick: closePop }));
    pop.appendChild(el('h4', null, row.device + ' — ' + part.label));

    const dl = el('dl');
    const add = (k, v, isNode) => { dl.appendChild(el('dt', null, k)); const dd = el('dd'); if (isNode) dd.appendChild(v); else dd.textContent = v; dl.appendChild(dd); };

    if (c.price == null) {
      add('Status', c.ts ? 'No match on the last pull' : 'Never pulled');
      if (c.title) add('Query', c.title);
    } else {
      add('Wholesale', money(c.price) + ' ex GST');
      if (calcCfg) {
        const retail = PPPCalc.computeRetail(c.price, calcCfg, state.gstPercent);
        const margin = PPPCalc.marginPercent(c.price, retail, calcCfg, state.gstPercent);
        add('Retail (' + store().name + ')', money(retail) + (margin != null ? '  ·  ' + margin + '% margin' : ''));
      }
      if (c.prev != null && c.prev !== c.price) {
        const diff = c.price - c.prev;
        add('Change', (diff > 0 ? '+' : '') + money(diff) + ' vs ' + money(c.prev));
      }
      add('Source', (d.sources.find(s => s.key === c.source) || {}).label || c.source);
      if (c.alt && c.alt.length) add('Also', c.alt.map(a => a.source + ' ' + money(a.price)).join(', '));
      if (c.manual) add('Note', 'Manually entered — pulls never overwrite it');
      if (c.pinned) add('Pin', 'Pinned to one exact product (Setup Mode)');
      add('Pulled', ago(c.ts));
      if (c.url) {
        const a = el('a', null, 'Open product page');
        a.href = c.url; a.target = '_blank'; a.rel = 'noopener';
        add('Link', a, true);
      }
    }
    pop.appendChild(dl);
    if (c.title && c.price != null) pop.appendChild(el('p', 'title', c.title));

    // position: prefer below-right of the cell, clamp into the viewport
    pop.hidden = false;
    const r = td.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let x = window.scrollX + Math.min(r.left, window.innerWidth - w - 12);
    let y = window.scrollY + r.bottom + 6;
    if (r.bottom + h + 12 > window.innerHeight) y = window.scrollY + Math.max(8, r.top - h - 6);
    pop.style.left = Math.max(8, x) + 'px';
    pop.style.top = y + 'px';
  }

  // ───────────────────────────────────────────── calculator drawer
  const drawer = $('#drawer'), scrim = $('#scrim'), statusDrawer = $('#statusDrawer');
  let draft = null;

  function openDrawer(node) { node.hidden = false; scrim.hidden = false; }
  function closeDrawers() { drawer.hidden = true; statusDrawer.hidden = true; scrim.hidden = true; }

  function openCalc() {
    const s = store();
    if (!s) return;
    draft = JSON.parse(JSON.stringify(s.calculator));
    $('#drawerTitle').textContent = 'Calculator — ' + s.name;
    $('#drawerHint').textContent = s.edited
      ? 'Saved for this store on ' + new Date(s.updatedAt).toLocaleDateString() + '. Git deploys never touch it.'
      : 'Currently using the seed from config/stores.yml. Saving makes it this store’s own.';
    fillForm();
    openDrawer(drawer);
  }

  function fillForm() {
    document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === draft.mode));
    $('#flatRow').style.display = draft.mode === 'flat' ? '' : 'none';
    $('#tiersBox').style.display = draft.mode === 'tiers' ? '' : 'none';
    $('#markupPercent').value = draft.markupPercent;
    $('#labour').value = draft.labour;
    $('#gst').checked = Boolean(draft.gst);
    $('#roundMode').value = draft.rounding.mode;
    $('#roundStep').value = draft.rounding.step;
    $('#endsWith').value = draft.rounding.endsWith == null ? '' : String(draft.rounding.endsWith);
    renderTiers();
    renderPreview();
  }

  function renderTiers() {
    const tb = $('#tiersBody');
    tb.innerHTML = '';
    draft.tiers.forEach((t, i) => {
      const tr = el('tr');
      const c1 = el('td'), up = el('input');
      up.type = 'number'; up.step = '1'; up.min = '0';
      up.value = t.upTo == null ? '' : t.upTo;
      up.placeholder = 'and above';
      up.oninput = () => { t.upTo = up.value === '' ? null : Number(up.value); renderPreview(); };
      c1.appendChild(up);

      const c2 = el('td'), mk = el('input');
      mk.type = 'number'; mk.step = '1'; mk.min = '0';
      mk.value = t.markupPercent;
      mk.oninput = () => { t.markupPercent = Number(mk.value); renderPreview(); };
      c2.appendChild(mk);

      const c3 = el('td'), del = el('button', 'del', '✕');
      del.title = 'Remove tier';
      del.onclick = () => { draft.tiers.splice(i, 1); renderTiers(); renderPreview(); };
      c3.appendChild(del);

      tr.append(c1, c2, c3);
      tb.appendChild(tr);
    });
  }

  function renderPreview() {
    const tb = $('#previewBody');
    tb.innerHTML = '';
    [15, 35, 75, 150, 320].forEach(w => {
      const retail = PPPCalc.computeRetail(w, draft, state.gstPercent);
      const margin = PPPCalc.marginPercent(w, retail, draft, state.gstPercent);
      const tr = el('tr');
      tr.append(el('td', null, money(w)), el('td', null, money(retail)), el('td', null, margin == null ? '—' : margin + '%'));
      tb.appendChild(tr);
    });
  }

  function readForm() {
    draft.markupPercent = Number($('#markupPercent').value) || 0;
    draft.labour = Number($('#labour').value) || 0;
    draft.gst = $('#gst').checked;
    draft.rounding.mode = $('#roundMode').value;
    draft.rounding.step = Number($('#roundStep').value) || 5;
    draft.rounding.endsWith = $('#endsWith').value === '' ? null : Number($('#endsWith').value);
    renderPreview();
  }

  // ───────────────────────────────────────────── status drawer
  async function openStatus() {
    openDrawer(statusDrawer);
    const box = $('#statusBody');
    box.textContent = 'Loading…';
    try {
      const s = await api('GET', '/api/status');
      box.innerHTML = '';
      const add = (k, v, cls) => { box.appendChild(el('b', null, k)); box.appendChild(el('span', cls || null, v)); };
      add('Version', 'v' + s.version + ' · auth ' + s.auth);
      add('Devices × parts', s.counts.devices + ' × ' + s.counts.parts + ' = ' + (s.counts.devices * s.counts.parts) + ' cells');
      add('Pins', String(s.counts.pins));
      add('Price rows', s.counts.prices.toLocaleString());
      add('Stores', String(s.counts.stores));
      add('Last price', ago(s.updated));
      add('Next scrape', s.schedule.day + ' ' + String(s.schedule.hour).padStart(2, '0') + ':00 ' + s.schedule.timezone);
      add('Config loaded', ago(s.config.loadedAt) + (s.config.error ? ' — ERROR' : ''), s.config.error ? 'bad' : 'ok');
      if (s.config.error) add('Config error', s.config.error.message, 'bad');
      add('Git', s.git.enabled
        ? (s.git.ok === false ? 'FAILED: ' + s.git.message : (s.git.head || '?') + ' · ' + s.git.message + ' · every ' + s.git.intervalSec + 's')
        : 'sync disabled', s.git.ok === false ? 'bad' : null);
    } catch (e) {
      box.textContent = 'Status unavailable: ' + e.message;
    }
    try {
      const r = await api('GET', '/api/logs?limit=60');
      const lb = $('#logBody');
      lb.innerHTML = '';
      r.logs.forEach(l => {
        const d = el('div');
        d.appendChild(Object.assign(el('time', null, new Date(l.ts).toLocaleString()), { dateTime: l.ts }));
        d.appendChild(el('span', null, (l.source ? '[' + l.source + '] ' : '') + l.message));
        lb.appendChild(d);
      });
    } catch (e) { $('#logBody').textContent = e.message; }
  }

  async function checkBanner() {
    try {
      const s = await api('GET', '/api/status');
      const b = $('#banner');
      if (s.config.error) {
        b.hidden = false;
        b.textContent = '⚠ config/*.yml failed to load (' + s.config.error.message + ') — the site is running on the last good copy.';
      } else if (s.git.enabled && s.git.ok === false) {
        b.hidden = false;
        b.textContent = '⚠ git sync failing: ' + s.git.message;
      } else {
        b.hidden = true;
      }
      $('#counts').textContent = s.counts.pins + ' pins · ' + s.counts.devices + ' devices';
      $('#gitline').textContent = s.git.enabled ? 'config @ ' + (s.git.head || '?') : 'config from disk';
    } catch (e) { /* not fatal */ }
  }

  // ───────────────────────────────────────────── wiring
  $('#storeSel').onchange = e => {
    state.storeId = e.target.value;
    localStorage.setItem('ppp.store', state.storeId);
    if (state.storeId && state.view === 'wholesale') state.view = 'both';
    reflectViewAvailability();
    render();
  };

  $('#gradeSel').onchange = e => {
    state.grade = e.target.value;
    localStorage.setItem('ppp.grade', state.grade);
    loadMatrix().catch(err => alert(err.message));
  };

  $('#viewSeg').onclick = e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    state.view = b.dataset.view;
    localStorage.setItem('ppp.view', state.view);
    reflectViewAvailability();
    render();
  };

  $('#search').oninput = e => { state.filter = e.target.value; applyFilter(); };

  $('#body').onclick = e => {
    const td = e.target.closest('td.cell');
    if (!td || td.classList.contains('empty') && !td.dataset.miss) return closePop();
    openPop(td);
    e.stopPropagation();
  };
  document.addEventListener('click', e => { if (!pop.hidden && !pop.contains(e.target)) closePop(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closePop(); closeDrawers(); } });

  $('#calcBtn').onclick = openCalc;
  $('#statusBtn').onclick = openStatus;
  $('#drawerClose').onclick = closeDrawers;
  $('#statusClose').onclick = closeDrawers;
  scrim.onclick = closeDrawers;

  $('#modeSeg').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    draft.mode = b.dataset.mode;
    fillForm();
  };
  $('#addTier').onclick = () => { draft.tiers.push({ upTo: null, markupPercent: draft.markupPercent }); renderTiers(); renderPreview(); };
  ['#markupPercent', '#labour', '#gst', '#roundMode', '#roundStep', '#endsWith'].forEach(sel => {
    $(sel).addEventListener('input', readForm);
    $(sel).addEventListener('change', readForm);
  });

  $('#saveCalc').onclick = async () => {
    readForm();
    const btn = $('#saveCalc');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await api('PUT', '/api/stores/' + encodeURIComponent(state.storeId) + '/calculator', draft);
      const i = state.stores.findIndex(s => s.id === r.store.id);
      state.stores[i] = r.store;
      draft = JSON.parse(JSON.stringify(r.store.calculator));
      render();
      btn.textContent = 'Saved ✓';
      setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1200);
    } catch (e) {
      alert('Save failed: ' + e.message);
      btn.textContent = 'Save'; btn.disabled = false;
    }
  };

  $('#resetCalc').onclick = async () => {
    if (!confirm('Discard this store’s saved calculator and go back to the values in config/stores.yml?')) return;
    const r = await api('DELETE', '/api/stores/' + encodeURIComponent(state.storeId) + '/calculator');
    const i = state.stores.findIndex(s => s.id === r.store.id);
    state.stores[i] = r.store;
    draft = JSON.parse(JSON.stringify(r.store.calculator));
    fillForm();
    render();
  };

  $('#pullBtn').onclick = async () => {
    const out = $('#pullOut'), btn = $('#pullBtn');
    out.hidden = false; out.textContent = 'Pulling…'; btn.disabled = true;
    try {
      const r = await api('POST', '/api/git/pull');
      out.textContent = r.ok ? `✓ ${r.head} — ${r.message}` : `✗ ${r.message}`;
      await loadStores();
      await loadMatrix();
    } catch (e) { out.textContent = '✗ ' + e.message; }
    btn.disabled = false;
    checkBanner();
  };

  $('#logoutBtn').onclick = async () => { await api('POST', '/api/logout'); location.href = '/login'; };

  // ───────────────────────────────────────────── boot
  (async function boot() {
    if (state.filter) $('#search').value = state.filter;
    try {
      await loadStores();
      await loadMatrix();
      checkBanner();
      // #calc deep-links straight into the selected store's calculator.
      if (location.hash === '#calc' && store()) openCalc();
    } catch (e) {
      $('#body').innerHTML = '';
      $('#body').appendChild(el('tr')).appendChild(el('td', 'loading', 'Could not load: ' + e.message));
    }
    setInterval(() => loadMatrix().catch(() => {}), 5 * 60 * 1000);
    setInterval(checkBanner, 60 * 1000);
  })();
})();
