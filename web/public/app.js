/* Parts Price Puller — front end.
   Wholesale comes from the server; RETAIL is computed in the browser with the same
   calc.js the server uses, so switching store or editing a rule repaints instantly
   without a round trip.

   Store / grade / view are remembered SERVER-SIDE (one shared login), so signing in
   on another device brings back the same view. */
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
    storeId: qs.get('store') || '',
    view: qs.get('view') || 'wholesale',
    grade: qs.get('grade') || '',
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

  let prefsTimer = null;
  function savePrefs() {
    clearTimeout(prefsTimer);
    prefsTimer = setTimeout(() => {
      api('PUT', '/api/prefs', { store: state.storeId, grade: state.grade, view: state.view }).catch(() => {});
    }, 400);
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

  const retailFor = (price, group, part) => {
    const s = store();
    return s ? PPPCalc.computeRetail(price, s.calculator, group, part) : null;
  };

  function render() {
    const d = state.data;
    if (!d) return;

    const head = $('#headRow');
    head.innerHTML = '';
    head.appendChild(Object.assign(el('th', 'devcol', 'Device'), { scope: 'col' }));
    d.parts.forEach(p => head.appendChild(Object.assign(el('th', null, p.label), { scope: 'col' })));

    const groups = new Map(d.groups.map(g => [g.id, g.label]));
    const view = store() ? state.view : 'wholesale';

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
        td.dataset.group = row.group;

        if (c.price == null) {
          td.classList.add('empty');
          td.textContent = c.ts ? '—' : '';
          if (c.ts) td.dataset.miss = '1';
        } else {
          const retail = retailFor(c.price, row.group, p.key);
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

  // ───────────────────────────────────────────── cell popover (left click)
  const pop = $('#pop');
  function closePop() { pop.hidden = true; }

  const cellOf = td => {
    const row = state.data.rows.find(r => r.device === td.dataset.device);
    return row ? row.cells[td.dataset.part] : null;
  };

  function openPop(td) {
    const d = state.data;
    const c = cellOf(td);
    if (!c) return;
    const part = d.parts.find(p => p.key === td.dataset.part);
    const s = store();

    pop.innerHTML = '';
    pop.appendChild(Object.assign(el('button', 'close', '✕'), { onclick: closePop }));
    pop.appendChild(el('h4', null, td.dataset.device + ' — ' + part.label));

    const dl = el('dl');
    const add = (k, v, isNode) => { dl.appendChild(el('dt', null, k)); const dd = el('dd'); if (isNode) dd.appendChild(v); else dd.textContent = v; dl.appendChild(dd); };

    if (c.price == null) {
      add('Status', c.ts ? 'No match on the last pull' : 'Never pulled');
      if (c.title) add('Query', c.title);
    } else {
      add(c.manual ? 'Manual price' : 'Wholesale', money(c.price) + ' ex GST');
      if (s) {
        const retail = retailFor(c.price, td.dataset.group, part.key);
        const margin = PPPCalc.marginPercent(c.price, retail, state.gstPercent);
        add('Retail (' + s.name + ')', money(retail) + (margin != null ? '  ·  ' + margin + '% margin' : ''));
        const rule = PPPCalc.resolveRule(s.calculator, td.dataset.group, part.key);
        add('Rule', PPPCalc.describeRule(rule, state.currency));
      }
      if (c.prev != null && c.prev !== c.price) {
        const diff = c.price - c.prev;
        add('Change', (diff > 0 ? '+' : '') + money(diff) + ' vs ' + money(c.prev));
      }
      add('Source', c.manual ? 'Entered by hand — pulls never overwrite it'
        : ((d.sources.find(x => x.key === c.source) || {}).label || c.source));
      if (c.alt && c.alt.length) add('Also', c.alt.map(a => a.source + ' ' + money(a.price)).join(', '));
      if (c.pinned) add('Pin', 'Pinned to one exact product (Setup Mode)');
      add(c.manual ? 'Set' : 'Pulled', ago(c.ts));
      if (c.url) {
        const a = el('a', null, 'Open product page');
        a.href = c.url; a.target = '_blank'; a.rel = 'noopener';
        add('Link', a, true);
      }
    }
    pop.appendChild(dl);
    if (c.title && c.price != null && !c.manual) pop.appendChild(el('p', 'title', c.title));
    pop.appendChild(el('p', 'title', 'Right-click for manual price'));

    place(pop, td);
  }

  // Position a floating panel near a cell, clamped into the viewport.
  function place(node, td) {
    node.hidden = false;
    const r = td.getBoundingClientRect();
    const w = node.offsetWidth, h = node.offsetHeight;
    const x = window.scrollX + Math.min(r.left, window.innerWidth - w - 12);
    let y = window.scrollY + r.bottom + 6;
    if (r.bottom + h + 12 > window.innerHeight) y = window.scrollY + Math.max(8, r.top - h - 6);
    node.style.left = Math.max(8, x) + 'px';
    node.style.top = y + 'px';
  }

  // ───────────────────────────────────────────── right-click: manual price
  // Two deliberate steps — right-click, then click Edit — so a price can never be
  // nudged by a stray click. Saved manual prices outrank every supplier price and no
  // pull will overwrite them.
  const menu = $('#menu');
  const closeMenu = () => { menu.hidden = true; };

  // Clicking an item swaps the menu's contents (Edit → the price input), which detaches
  // the clicked node. The click-away listener below would then see a target that is no
  // longer inside #menu and close it. Stop menu clicks from reaching document at all.
  menu.addEventListener('click', e => e.stopPropagation());

  function openMenu(td) {
    closePop();
    const c = cellOf(td);
    if (!c) return;
    const part = state.data.parts.find(p => p.key === td.dataset.part);

    menu.innerHTML = '';
    menu.appendChild(el('div', 'menu-hd', td.dataset.device + ' — ' + part.label));

    const item = (label, cls, fn) => {
      const b = el('button', 'menu-item' + (cls ? ' ' + cls : ''), label);
      b.onclick = fn;
      menu.appendChild(b);
      return b;
    };

    item(c.manual ? '✏ Edit manual price' : '✏ Edit price (set manually)', '', () => showEditor(td, c));
    if (c.manual) {
      item('↩ Clear manual price', 'danger', async () => {
        await saveManual(td, null);
      });
    }
    if (c.url) {
      item('🔗 Open product page', '', () => { window.open(c.url, '_blank', 'noopener'); closeMenu(); });
    }
    item('✕ Cancel', 'muted', closeMenu);

    place(menu, td);
  }

  function showEditor(td, c) {
    const part = state.data.parts.find(p => p.key === td.dataset.part);
    menu.innerHTML = '';
    menu.appendChild(el('div', 'menu-hd', td.dataset.device + ' — ' + part.label));

    const wrap = el('div', 'menu-edit');
    const input = el('input');
    input.type = 'number'; input.step = '0.01'; input.min = '0';
    input.value = c.price == null ? '' : c.price;
    input.placeholder = 'wholesale cost, ex GST';
    wrap.appendChild(input);

    const preview = el('div', 'menu-preview');
    const updatePreview = () => {
      const v = Number(input.value);
      const s = store();
      preview.textContent = !s
        ? 'Pick a store to preview retail'
        : (v > 0 ? 'Retail: ' + money(retailFor(v, td.dataset.group, part.key)) : '');
    };
    input.addEventListener('input', updatePreview);
    updatePreview();
    wrap.appendChild(preview);

    const row = el('div', 'menu-actions');
    const save = el('button', 'btn small', 'Save');
    save.onclick = async () => {
      const v = Number(input.value);
      if (!(v > 0)) { preview.textContent = 'Enter a price above 0.'; return; }
      save.disabled = true; save.textContent = 'Saving…';
      await saveManual(td, v);
    };
    const cancel = el('button', 'btn ghost small', 'Cancel');
    cancel.onclick = closeMenu;
    row.append(save, cancel);
    wrap.appendChild(row);
    menu.appendChild(wrap);

    place(menu, td);
    input.focus();
    input.select();
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); save.click(); }
      if (ev.key === 'Escape') closeMenu();
    });
  }

  async function saveManual(td, price) {
    try {
      await api('POST', '/api/manual', {
        device: td.dataset.device,
        part: td.dataset.part,
        grade: state.grade,
        price,
      });
      closeMenu();
      await loadMatrix();
    } catch (e) {
      alert('Could not save: ' + e.message);
    }
  }

  // ───────────────────────────────────────────── calculator drawer
  const drawer = $('#drawer'), scrim = $('#scrim'), statusDrawer = $('#statusDrawer');
  let draft = null;          // calculator being edited
  let draftGroup = null;     // device group tab currently shown

  function openDrawer(node) { node.hidden = false; scrim.hidden = false; }
  function closeDrawers() { drawer.hidden = true; statusDrawer.hidden = true; scrim.hidden = true; }

  function openCalc() {
    const s = store();
    if (!s) return;
    draft = JSON.parse(JSON.stringify(s.calculator));
    draft.rules = draft.rules || {};
    draftGroup = draftGroup || (state.data.groups[0] && state.data.groups[0].id) || '*';
    $('#drawerTitle').textContent = 'Calculator — ' + s.name;
    $('#drawerHint').textContent = s.edited
      ? 'Saved for this store on ' + new Date(s.updatedAt).toLocaleDateString() + '. Git deploys never touch it.'
      : 'Currently using the seed from config/stores.yml. Saving makes it this store’s own.';
    $('#roundMode').value = draft.rounding.mode;
    $('#roundStep').value = draft.rounding.step;
    $('#endsWith').value = draft.rounding.endsWith == null ? '' : String(draft.rounding.endsWith);
    renderGroupTabs();
    renderRules();
    openDrawer(drawer);
  }

  function renderGroupTabs() {
    const seg = $('#groupSeg');
    seg.innerHTML = '';
    // "All devices" is the *|… level; each group tab writes group|… rules.
    const tabs = [{ id: '*', label: 'All devices' }].concat(state.data.groups);
    tabs.forEach(g => {
      const b = el('button', g.id === draftGroup ? 'on' : null, g.label);
      b.dataset.group = g.id;
      b.onclick = () => { draftGroup = g.id; renderGroupTabs(); renderRules(); };
      seg.appendChild(b);
    });
  }

  const num = v => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));

  function renderRules() {
    const tb = $('#rulesBody');
    tb.innerHTML = '';
    $('#previewGroup').textContent = draftGroup === '*' ? 'all devices' :
      (state.data.groups.find(g => g.id === draftGroup) || {}).label || draftGroup;
    $('#inheritNote').textContent = draftGroup === '*'
      ? 'These apply to every device family unless that family overrides them below.'
      : 'Blank = inherit from “All devices”. Fill a box to override it for this family only.';

    // Rules are not per grade, so drop the "(BQ7)" suffix the matrix headers carry.
    const plain = s => String(s).replace(/\s*\([^)]*\)\s*$/, '');
    const rows = [{ key: '*', label: draftGroup === '*' ? 'All parts (base)' : 'All parts here' }]
      .concat(state.data.parts.map(p => ({ key: p.key, label: plain(p.label) })));

    rows.forEach(r => {
      const ruleKey = PPPCalc.keyFor(draftGroup, r.key);
      const rule = draft.rules[ruleKey] || {};
      // What this cell resolves to WITHOUT its own values — shown as the placeholder,
      // so an empty box visibly says "inheriting 110".
      const parentSaved = draft.rules[ruleKey];
      delete draft.rules[ruleKey];
      const inherited = PPPCalc.resolveRule(draft, draftGroup, r.key);
      if (parentSaved) draft.rules[ruleKey] = parentSaved;

      const tr = el('tr', r.key === '*' ? 'baserule' : null);
      tr.appendChild(el('td', null, r.label));

      PPPCalc.FIELDS.forEach(f => {
        const td = el('td');
        const input = el('input');
        input.type = 'number';
        input.step = f === 'multiplyPercent' || f === 'overMultiplyPercent' ? '1' : '0.01';
        input.min = '0';
        input.value = rule[f] == null ? '' : rule[f];
        input.placeholder = inherited[f] == null ? '—' : String(inherited[f]);
        input.oninput = () => {
          const v = num(input.value);
          const cur = draft.rules[ruleKey] || {};
          if (v == null) delete cur[f]; else cur[f] = v;
          if (Object.keys(cur).length) draft.rules[ruleKey] = cur;
          else delete draft.rules[ruleKey];
          renderExample(tr, r.key);
          renderPreview();
        };
        td.appendChild(input);
        tr.appendChild(td);
      });

      tr.appendChild(el('td', 'example'));
      tb.appendChild(tr);
      renderExample(tr, r.key);
    });
    renderPreview();
  }

  function renderExample(tr, partKey) {
    const cell = tr.querySelector('.example');
    if (!cell) return;
    cell.textContent = money(PPPCalc.computeRetail(60, draft, draftGroup, partKey === '*' ? '*' : partKey));
  }

  function renderPreview() {
    const tb = $('#previewBody');
    tb.innerHTML = '';
    const costs = [25, 60, 150, 400];
    const plain = s => String(s).replace(/\s*\([^)]*\)\s*$/, '');
    const rows = [{ key: '*', label: 'Base' }].concat(state.data.parts.map(p => ({ key: p.key, label: plain(p.label) })));
    rows.forEach(r => {
      const tr = el('tr');
      tr.appendChild(el('td', null, r.label));
      costs.forEach(c => tr.appendChild(el('td', null, money(PPPCalc.computeRetail(c, draft, draftGroup, r.key)))));
      tb.appendChild(tr);
    });
  }

  function readRounding() {
    draft.rounding.mode = $('#roundMode').value;
    draft.rounding.step = Number($('#roundStep').value) || 5;
    draft.rounding.endsWith = $('#endsWith').value === '' ? null : Number($('#endsWith').value);
    renderRules();
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
      add('Webhook', s.webhook ? 'signed — POST /hooks/pricing' : 'unsigned (set WEBHOOK_SECRET)');
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
    if (state.storeId && state.view === 'wholesale') state.view = 'both';
    reflectViewAvailability();
    render();
    savePrefs();
  };

  $('#gradeSel').onchange = e => {
    state.grade = e.target.value;
    savePrefs();
    loadMatrix().catch(err => alert(err.message));
  };

  $('#viewSeg').onclick = e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    state.view = b.dataset.view;
    reflectViewAvailability();
    render();
    savePrefs();
  };

  $('#search').oninput = e => { state.filter = e.target.value; applyFilter(); };

  $('#body').onclick = e => {
    const td = e.target.closest('td.cell');
    closeMenu();
    if (!td || (td.classList.contains('empty') && !td.dataset.miss)) return closePop();
    openPop(td);
    e.stopPropagation();
  };

  $('#body').oncontextmenu = e => {
    const td = e.target.closest('td.cell');
    if (!td) return;
    e.preventDefault();
    openMenu(td);
  };

  document.addEventListener('click', e => {
    if (!pop.hidden && !pop.contains(e.target)) closePop();
    if (!menu.hidden && !menu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closePop(); closeMenu(); closeDrawers(); } });

  $('#calcBtn').onclick = openCalc;
  $('#statusBtn').onclick = openStatus;
  $('#drawerClose').onclick = closeDrawers;
  $('#statusClose').onclick = closeDrawers;
  scrim.onclick = closeDrawers;

  ['#roundMode', '#roundStep', '#endsWith'].forEach(sel => {
    $(sel).addEventListener('change', readRounding);
    $(sel).addEventListener('input', readRounding);
  });

  $('#saveCalc').onclick = async () => {
    readRounding();
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
    renderRules();
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
    try {
      // Server-side prefs first (they follow the login), query string wins over them.
      const p = (await api('GET', '/api/prefs').catch(() => ({ prefs: {} }))).prefs || {};
      if (!qs.get('store') && p.store) state.storeId = p.store;
      if (!qs.get('grade') && p.grade) state.grade = p.grade;
      if (!qs.get('view') && p.view) state.view = p.view;
      if (state.filter) $('#search').value = state.filter;

      await loadStores();
      await loadMatrix();
      checkBanner();
      if (location.hash === '#calc' && store()) openCalc();
    } catch (e) {
      $('#body').innerHTML = '';
      $('#body').appendChild(el('tr')).appendChild(el('td', 'loading', 'Could not load: ' + e.message));
    }
    setInterval(() => loadMatrix().catch(() => {}), 5 * 60 * 1000);
    setInterval(checkBanner, 60 * 1000);
  })();
})();
