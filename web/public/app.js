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
    family: qs.get('family') || localStorage.getItem('ppp.family') || '',   // active device tab
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
      api('PUT', '/api/prefs', { store: state.storeId, grade: state.grade, view: state.view, family: state.family }).catch(() => {});
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

  // Retail for a cell: a per-store manual override wins over the calculated figure.
  // deviceName is optional (the calculator preview passes hypothetical costs, no device).
  function retailInfo(price, group, partKey, deviceName) {
    const s = store();
    if (!s) return { value: null, fixed: false };
    if (deviceName) {
      const g = (partMeta(partKey).graded) ? state.grade : '';
      const ov = s.retailOverrides ? s.retailOverrides[deviceName + '|' + partKey + '|' + g] : undefined;
      if (ov != null) return { value: ov, fixed: true };
    }
    return { value: PPPCalc.computeRetail(price, s.calculator, group, partKey), fixed: false };
  }
  const retailFor = (price, group, part, device) => retailInfo(price, group, part, device).value;

  // 4-week trend → a green(cheaper)↔red(dearer) wash, intensity by magnitude. Capped so
  // even a huge swing stays legible. Manual cells are left clean (blue), no wash.
  function applyTrend(td, price, ref) {
    if (ref == null || !(ref > 0) || price === ref) return;
    const pct = Math.max(-0.5, Math.min(0.5, (price - ref) / ref)) / 0.5;   // -1 … 1
    const alpha = (Math.abs(pct) * 0.5).toFixed(3);
    td.style.background = `rgba(var(${pct > 0 ? '--trend-up' : '--trend-down'}), ${alpha})`;
    td.classList.add(pct > 0 ? 'up' : 'down');
  }

  // Which families actually have devices, in config order. This drives the right rail.
  function activeGroups() {
    const d = state.data;
    if (!d) return [];
    const used = new Set(d.rows.map(r => r.group));
    return d.groups.filter(g => used.has(g.id));
  }
  const currentGroup = () => {
    const gs = activeGroups();
    return gs.find(g => g.id === state.family) || gs[0] || null;
  };
  const partMeta = key => (state.data.parts.find(p => p.key === key) || { key, label: key });

  // How many devices in a family match the current filter — powers the rail counts.
  function familyMatchCount(gid) {
    const q = state.filter.trim().toLowerCase();
    return state.data.rows.filter(r => r.group === gid && (!q || r.device.toLowerCase().includes(q))).length;
  }

  function renderFamilyRail() {
    const rail = $('#familyRail');
    rail.innerHTML = '';
    const cur = currentGroup();
    activeGroups().forEach(g => {
      const b = el('button', 'fam' + (cur && g.id === cur.id ? ' on' : ''));
      b.appendChild(el('span', 'fam-label', g.label));
      const n = familyMatchCount(g.id);
      const count = el('span', 'fam-count', String(n));
      if (state.filter.trim() && n === 0) b.classList.add('dim');
      b.appendChild(count);
      b.onclick = () => {
        state.family = g.id;
        localStorage.setItem('ppp.family', g.id);
        savePrefs();
        render();
      };
      rail.appendChild(b);
    });
  }

  function render() {
    const d = state.data;
    if (!d) return;

    renderFamilyRail();
    const group = currentGroup();
    const cols = (group && group.parts) || d.parts.map(p => p.key);
    const view = store() ? state.view : 'wholesale';

    // header: Device + this family's columns only
    const head = $('#headRow');
    head.innerHTML = '';
    head.appendChild(Object.assign(el('th', 'devcol', (group ? group.label : 'Device')), { scope: 'col' }));
    cols.forEach(k => head.appendChild(Object.assign(el('th', null, partMeta(k).label), { scope: 'col' })));

    const body = document.createDocumentFragment();
    const rows = d.rows.filter(r => !group || r.group === group.id);

    rows.forEach(row => {
      const tr = el('tr');
      tr.dataset.device = row.device.toLowerCase();
      tr.appendChild(el('td', 'devcol', row.device));

      cols.forEach(k => {
        const c = row.cells[k] || {};
        const td = el('td', 'cell');
        td.dataset.device = row.device;
        td.dataset.part = k;
        td.dataset.group = row.group;

        const ri = retailInfo(c.price, row.group, k, row.device);
        // A cell can be "empty" of wholesale yet still carry a fixed retail override.
        if (c.price == null && ri.value == null) {
          td.classList.add('empty');
          td.textContent = c.ts ? '—' : '';
          if (c.ts) td.dataset.miss = '1';
        } else {
          if (c.manual) td.classList.add('manual');
          else if (c.price != null) applyTrend(td, c.price, c.ref4w);   // 4-week wash
          if (ri.fixed) td.classList.add('retail-fixed');
          if (c.pinned) td.classList.add('pinned');

          const wSpan = () => el('span', 'w', c.price == null ? '—' : money(c.price));
          const rSpan = () => el('span', 'r', money(ri.value));
          if (view === 'wholesale') {
            td.appendChild(wSpan());
          } else if (view === 'retail') {
            td.appendChild(rSpan());
          } else {
            td.classList.add('both');
            td.appendChild(wSpan());
            td.appendChild(rSpan());
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
    let shown = 0;
    for (const tr of $('#body').children) {
      const hit = !q || (tr.dataset.device || '').includes(q);
      tr.classList.toggle('hidden', !hit);
      if (hit) shown++;
    }
    // A filter that hits nothing in this family but matches another one: nudge the user
    // there instead of showing an empty grid.
    if (q && shown === 0) {
      const other = activeGroups().find(g => g.id !== (currentGroup() || {}).id && familyMatchCount(g.id) > 0);
      if (other) {
        state.family = other.id;
        localStorage.setItem('ppp.family', other.id);
        return render();
      }
    }
    renderFamilyRail();   // refresh the per-family match counts
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

    const ri = retailInfo(c.price, td.dataset.group, part.key, td.dataset.device);
    if (c.price == null && ri.value == null) {
      add('Status', c.ts ? 'No match on the last pull' : 'Never pulled');
      if (c.title) add('Query', c.title);
    } else {
      if (c.price != null) add(c.manual ? 'Manual price' : 'Wholesale', money(c.price) + ' ex GST');
      if (s && ri.value != null) {
        const margin = c.price != null ? PPPCalc.marginPercent(c.price, ri.value, state.gstPercent) : null;
        add('Retail (' + s.name + ')', money(ri.value) + (ri.fixed ? '  ·  fixed by hand' : (margin != null ? '  ·  ' + margin + '% margin' : '')));
        if (!ri.fixed && c.price != null) {
          const rule = PPPCalc.resolveRule(s.calculator, td.dataset.group, part.key);
          add('Rule', PPPCalc.describeRule(rule, state.currency));
        }
      }
      // 4-week trend (what drives the cell colour)
      if (c.price != null && c.ref4w != null && c.ref4w !== c.price) {
        const diff = c.price - c.ref4w;
        const pct = Math.round((diff / c.ref4w) * 100);
        add('4-week change', (diff > 0 ? '▲ +' : '▼ −') + money(Math.abs(diff)) + '  (' + (pct > 0 ? '+' : '') + pct + '%, was ' + money(c.ref4w) + ')');
      } else if (c.price != null && c.ref4w == null) {
        add('4-week change', 'no data yet');
      }
      if (ri.fixed && c.price == null) add('Note', 'Retail set by hand; no wholesale on record');
      if (c.price != null) {
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
    }
    pop.appendChild(dl);
    if (c.title && c.price != null && !c.manual) pop.appendChild(el('p', 'title', c.title));
    pop.appendChild(el('p', 'title', 'Right-click to set wholesale or retail'));

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

    const hasStore = Boolean(store());
    const retailFixed = retailInfo(c.price, td.dataset.group, td.dataset.part, td.dataset.device).fixed;
    item(c.manual ? '✏ Edit wholesale price' : '✏ Set wholesale price', '', () => showEditor(td, c, 'wholesale'));
    if (hasStore) item(retailFixed ? '✏ Edit retail price' : '✏ Set retail price', '', () => showEditor(td, c, 'retail'));
    if (c.manual) {
      item('↩ Clear wholesale price', 'danger', async () => { await saveManual(td, null, 'wholesale'); });
    }
    if (retailFixed) {
      item('↩ Clear retail price', 'danger', async () => { await saveManual(td, null, 'retail'); });
    }
    if (c.url) {
      item('🔗 Open product page', '', () => { window.open(c.url, '_blank', 'noopener'); closeMenu(); });
    }
    // The only way to drop a pin — Setup Mode can re-pin a cell but never unbind one,
    // and the sheet's Pins tab (where you used to delete the row) is gone.
    if (c.pinned) {
      item('📌 Unpin this cell', 'danger', async () => {
        try {
          await api('DELETE', '/api/pins', {
            device: td.dataset.device, part: td.dataset.part, grade: state.grade, source: c.source === 'MANUAL' ? 'CP' : (c.source || 'CP'),
          });
          closeMenu();
          await loadMatrix();
        } catch (e) { alert('Could not unpin: ' + e.message); }
      });
    }
    item('✕ Cancel', 'muted', closeMenu);

    place(menu, td);
  }

  // kind: 'wholesale' = a MANUAL cost (feeds every store's calculator);
  //       'retail'    = a fixed retail figure for the current store only.
  function showEditor(td, c, kind) {
    const part = state.data.parts.find(p => p.key === td.dataset.part);
    const isRetail = kind === 'retail';
    menu.innerHTML = '';
    menu.appendChild(el('div', 'menu-hd', td.dataset.device + ' — ' + part.label));

    const wrap = el('div', 'menu-edit');
    wrap.appendChild(el('div', 'menu-kind', isRetail
      ? 'Fixed RETAIL for ' + store().name + ' — overrides the calculator'
      : 'WHOLESALE cost — every store’s retail is worked out from it'));

    const input = el('input');
    input.type = 'number'; input.step = '0.01'; input.min = '0';
    const cur = isRetail ? retailInfo(c.price, td.dataset.group, td.dataset.part, td.dataset.device) : null;
    input.value = isRetail ? (cur.fixed ? cur.value : '') : (c.manual && c.price != null ? c.price : '');
    input.placeholder = isRetail ? 'retail price, inc GST' : 'wholesale cost, ex GST';
    wrap.appendChild(input);

    const preview = el('div', 'menu-preview');
    const updatePreview = () => {
      const v = Number(input.value);
      if (isRetail) {
        preview.textContent = v > 0 ? 'Sells for ' + money(v) : '';
      } else {
        const s = store();
        preview.textContent = !s ? 'Pick a store to preview retail'
          : (v > 0 ? 'Retail: ' + money(retailFor(v, td.dataset.group, part.key)) : '');
      }
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
      await saveManual(td, v, kind);
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

  async function saveManual(td, price, kind) {
    try {
      await api('POST', '/api/manual', {
        device: td.dataset.device,
        part: td.dataset.part,
        grade: state.grade,
        kind: kind || 'wholesale',
        store: state.storeId,
        price,
      });
      closeMenu();
      if (kind === 'retail') {
        // Overrides live on the store payload — refresh it so the change shows at once.
        await loadStores();
      }
      await loadMatrix();
    } catch (e) {
      alert('Could not save: ' + e.message);
    }
  }

  // ───────────────────────────────────────────── calculator drawer
  const drawer = $('#drawer'), scrim = $('#scrim'), statusDrawer = $('#statusDrawer'), devicesDrawer = $('#devicesDrawer');
  let draft = null;          // calculator being edited
  let draftGroup = null;     // device group tab currently shown

  function openDrawer(node) { node.hidden = false; scrim.hidden = false; }
  function closeDrawers() { drawer.hidden = true; statusDrawer.hidden = true; devicesDrawer.hidden = true; scrim.hidden = true; }

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

  // Parts to show for a calculator tab. A specific family shows only its own columns
  // (so the iPad tab lists just LCD + Digitiser); "All devices" shows every part any
  // family uses, so a base rule can be set for all of them.
  const plainLabel = s => String(s).replace(/\s*\([^)]*\)\s*$/, '');
  function calcParts(groupId) {
    let keys;
    if (groupId === '*') {
      keys = [];
      state.data.groups.forEach(g => (g.parts || []).forEach(k => { if (!keys.includes(k)) keys.push(k); }));
      if (!keys.length) keys = state.data.parts.map(p => p.key);
    } else {
      const g = state.data.groups.find(x => x.id === groupId);
      keys = (g && g.parts) || state.data.parts.map(p => p.key);
    }
    return keys.map(k => ({ key: k, label: plainLabel(partMeta(k).label) }));
  }

  function renderRules() {
    const tb = $('#rulesBody');
    tb.innerHTML = '';
    $('#previewGroup').textContent = draftGroup === '*' ? 'all devices' :
      (state.data.groups.find(g => g.id === draftGroup) || {}).label || draftGroup;
    $('#inheritNote').textContent = draftGroup === '*'
      ? 'These apply to every device family unless that family overrides them below.'
      : 'Blank = inherit from “All devices”. Fill a box to override it for this family only.';

    const rows = [{ key: '*', label: draftGroup === '*' ? 'All parts (base)' : 'All parts here' }]
      .concat(calcParts(draftGroup));

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
    const rows = [{ key: '*', label: 'Base' }].concat(calcParts(draftGroup));
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

  // ───────────────────────────────────────────── devices drawer
  async function openDevices() {
    const gsel = $('#ndGroup');
    if (!gsel.options.length) {
      state.data.groups.forEach(g => gsel.add(new Option(g.label, g.id)));
    }
    if (state.family) gsel.value = state.family;
    $('#ndMsg').textContent = '';
    openDrawer(devicesDrawer);
    await refreshCustomList();
  }

  async function refreshCustomList() {
    const box = $('#customList');
    box.textContent = 'Loading…';
    try {
      const r = await api('GET', '/api/devices');
      const groupLabel = id => (state.data.groups.find(g => g.id === id) || {}).label || id;
      box.innerHTML = '';
      if (!r.devices.length) { box.appendChild(el('div', 'none', 'None yet — add one above.')); return; }
      r.devices.forEach(d => {
        const row = el('div', 'drow');
        const left = el('div');
        left.appendChild(el('div', null, d.name));
        left.appendChild(el('div', 'meta', groupLabel(d.grp)));
        row.appendChild(left);
        const del = el('button', null, '✕');
        del.title = 'Remove ' + d.name;
        del.onclick = async () => {
          if (!confirm('Remove ' + d.name + '? Any prices/pins on it stay in history but the row goes.')) return;
          await api('DELETE', '/api/devices/' + d.id);
          await refreshCustomList();
          await loadMatrix();
        };
        row.appendChild(del);
        box.appendChild(row);
      });
    } catch (e) { box.textContent = e.message; }
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
  $('#devicesBtn').onclick = openDevices;
  $('#drawerClose').onclick = closeDrawers;
  $('#statusClose').onclick = closeDrawers;
  $('#devicesClose').onclick = closeDrawers;
  scrim.onclick = closeDrawers;

  $('#ndAdd').onclick = async () => {
    const name = $('#ndName').value.trim();
    const msg = $('#ndMsg');
    if (!name) { msg.textContent = 'Enter a name.'; return; }
    try {
      await api('POST', '/api/devices', { name, group: $('#ndGroup').value, search: $('#ndSearch').value.trim() });
      $('#ndName').value = ''; $('#ndSearch').value = '';
      msg.textContent = '✓ Added ' + name;
      state.family = $('#ndGroup').value;   // jump to the family it landed in
      localStorage.setItem('ppp.family', state.family);
      await refreshCustomList();
      await loadMatrix();
    } catch (e) { msg.textContent = '✗ ' + e.message; }
  };
  $('#ndName').addEventListener('keydown', e => { if (e.key === 'Enter') $('#ndAdd').click(); });

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
      if (!qs.get('family') && !state.family && p.family) state.family = p.family;
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
