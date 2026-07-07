/**
 * PARTS PRICE PULLER — Google Apps Script (bind to your Sheet)
 * v1.0.0
 *
 * SETUP:
 * 1. Create a new Google Sheet
 * 2. Extensions > Apps Script > paste this whole file > Save
 * 3. Run setupSheets() once (authorise when prompted)
 * 4. Deploy > New deployment > Web app
 *      Execute as: Me
 *      Who has access: Anyone
 *    Copy the /exec URL — that goes into the TM script + Willard scraper
 * 5. Set your shared key: Project Settings > Script properties > add
 *      KEY = some-long-random-string   (same string goes in the scrapers)
 */

const SH_PRICES  = 'Prices';
const SH_DEVICES = 'Devices';
const SH_CONFIG  = 'Config';
const SH_LOG     = 'Log';

// Part columns, in table order. key must match scrapers.
const PARTS = [
  { key: 'LCD',        label: 'LCD ({grade})' },
  { key: 'OLED',       label: 'OLED ({grade})' },
  { key: 'REFURB',     label: 'REFURB' },
  { key: 'SP',         label: 'SP Screen' },
  { key: 'BAT_AM',     label: 'Battery (AM)' },
  { key: 'BAT_SP',     label: 'Battery SP' },
  { key: 'CAM_REAR',   label: 'Rear Camera/s' },
  { key: 'CAM_FRONT',  label: 'Front Camera' },
  { key: 'BACK_GLASS', label: 'Back Glass' },
];

const SITES = [
  { key: 'CP',  label: 'CrazyParts' },
  { key: 'TPH', label: 'The Parts Home' },
];

// ---------------------------------------------------------------- MENU
function onOpen() {
  SpreadsheetApp.getUi().createMenu('💰 Price Puller')
    .addItem('Setup / Rebuild sheets (keeps data)', 'setupSheets')
    .addItem('Add device', 'menuAddDevice')
    .addItem('Rebuild Prices grid from Devices tab', 'rebuildPricesGrid')
    .addItem('Clear all prices', 'menuClearPrices')
    .addToUi();
}

// ---------------------------------------------------------------- SETUP
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // ---- Devices
  let dv = ss.getSheetByName(SH_DEVICES) || ss.insertSheet(SH_DEVICES);
  if (dv.getLastRow() < 2) {
    dv.clear();
    dv.getRange(1, 1, 1, 4).setValues([['Device Name', 'Search Term', 'Aliases (; separated)', 'Enabled']]).setFontWeight('bold');
    const devices = defaultDevices();
    dv.getRange(2, 1, devices.length, 4).setValues(devices);
    dv.setFrozenRows(1);
    dv.autoResizeColumns(1, 4);
  }

  // ---- Config
  let cf = ss.getSheetByName(SH_CONFIG) || ss.insertSheet(SH_CONFIG);
  if (cf.getLastRow() < 2) {
    cf.clear();
    cf.getRange('A1:B1').setValues([['Setting', 'Value']]).setFontWeight('bold');
    cf.getRange('A2:B6').setValues([
      ['Grade', 'BQ7'],                       // AMP / BQ7 / SP / INCELL / whatever the site names them
      ['Schedule Day', 'Sunday'],             // day for auto pull
      ['Schedule Hour (0-23)', '0'],          // 0 = 12am
      ['Rate Limit ms', '900'],               // delay between search requests
      ['Max results scanned per search', '12'],
    ]);
    // Grade dropdown
    cf.getRange('B2').setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['AMP', 'BQ7', 'SP', 'INCELL', 'HARD OLED', 'SOFT OLED'], true).setAllowInvalid(true).build());
    cf.getRange('B3').setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], true).build());

    // Query templates — fully editable. {device} {grade} substituted by scrapers.
    cf.getRange('A9:E9').setValues([['Part Key', 'Query Template', 'Must-match keywords (; any-of)', 'Exclude keywords (; separated)', 'Notes']]).setFontWeight('bold');
    cf.getRange('A10:E18').setValues([
      ['LCD',        '{device} LCD {grade}',          'lcd',                          'oled;refurb;service pack;frame only', ''],
      ['OLED',       '{device} OLED {grade}',         'oled;amoled',                  'refurb;service pack;incell;lcd',      ''],
      ['REFURB',     '{device} refurbished screen',   'refurb',                       'battery;camera',                      ''],
      ['SP',         '{device} service pack screen',  'service pack;genuine',         'battery;camera;back glass',           ''],
      ['BAT_AM',     '{device} battery',              'battery',                      'service pack;genuine;cover;case;door', ''],
      ['BAT_SP',     '{device} battery service pack', 'service pack;genuine',         'screen;lcd;oled',                     ''],
      ['CAM_REAR',   '{device} rear camera',          'rear camera;back camera;main camera', 'lens only;glass;bezel;front', 'lens-only excluded'],
      ['CAM_FRONT',  '{device} front camera',         'front camera',                 'lens;rear;back camera',               ''],
      ['BACK_GLASS', '{device} back glass',           'back glass;rear glass;back cover;battery cover', 'camera lens;screen;lcd;oled', ''],
    ]);
    cf.setFrozenRows(1);
    cf.autoResizeColumns(1, 5);
  }

  // ---- Log
  let lg = ss.getSheetByName(SH_LOG) || ss.insertSheet(SH_LOG);
  if (lg.getLastRow() < 1) {
    lg.getRange(1, 1, 1, 4).setValues([['Timestamp', 'Source', 'Site', 'Message']]).setFontWeight('bold');
    lg.setFrozenRows(1);
  }

  rebuildPricesGrid();
  // Non-blocking toast instead of getUi().alert(): running setupSheets() from the
  // editor with the Sheet tab unfocused makes alert() hang until the 6-min timeout.
  try {
    ss.toast('Setup done. Deploy as Web App (Deploy > New deployment) and set the KEY script property.', 'Parts Price Puller', 10);
  } catch (e) { /* no UI context (e.g. run headless) — ignore */ }
}

function defaultDevices() {
  const on = names => names.map(n => [n, n, '', true]);
  return on([
    // iPhone
    'iPhone 6', 'iPhone 6 Plus', 'iPhone 6s', 'iPhone 6s Plus',
    'iPhone SE (2016/2020/2022)',
    'iPhone 7', 'iPhone 7 Plus', 'iPhone 8', 'iPhone 8 Plus',
    'iPhone X', 'iPhone XR', 'iPhone XS', 'iPhone XS Max',
    'iPhone 11', 'iPhone 11 Pro', 'iPhone 11 Pro Max',
    'iPhone 12 Mini', 'iPhone 12', 'iPhone 12 Pro', 'iPhone 12 Pro Max',
    'iPhone 13 Mini', 'iPhone 13', 'iPhone 13 Pro', 'iPhone 13 Pro Max',
    'iPhone 14', 'iPhone 14 Plus', 'iPhone 14 Pro', 'iPhone 14 Pro Max',
    'iPhone 15', 'iPhone 15 Plus', 'iPhone 15 Pro', 'iPhone 15 Pro Max',
    'iPhone 16', 'iPhone 16 Plus', 'iPhone 16 Pro', 'iPhone 16 Pro Max',
    // Samsung S
    'Samsung S8', 'Samsung S8 Plus', 'Samsung S9', 'Samsung S9 Plus',
    'Samsung S10e', 'Samsung S10', 'Samsung S10 Plus',
    'Samsung S20', 'Samsung S20 Plus', 'Samsung S20 Ultra', 'Samsung S20 FE',
    'Samsung S21', 'Samsung S21 Plus', 'Samsung S21 Ultra', 'Samsung S21 FE',
    'Samsung S22', 'Samsung S22 Plus', 'Samsung S22 Ultra',
    'Samsung S23', 'Samsung S23 Plus', 'Samsung S23 Ultra', 'Samsung S23 FE',
    'Samsung S24', 'Samsung S24 Plus', 'Samsung S24 Ultra', 'Samsung S24 FE',
    'Samsung S25', 'Samsung S25 Plus', 'Samsung S25 Ultra',
    // Samsung A (common repair models — add/remove freely)
    'Samsung A05', 'Samsung A05s', 'Samsung A10', 'Samsung A11', 'Samsung A12', 'Samsung A13',
    'Samsung A14', 'Samsung A15', 'Samsung A16', 'Samsung A20', 'Samsung A21s', 'Samsung A22',
    'Samsung A23', 'Samsung A24', 'Samsung A25', 'Samsung A30', 'Samsung A32', 'Samsung A33',
    'Samsung A34', 'Samsung A35', 'Samsung A50', 'Samsung A51', 'Samsung A52', 'Samsung A53',
    'Samsung A54', 'Samsung A55', 'Samsung A70', 'Samsung A71', 'Samsung A72', 'Samsung A73',
  ]);
}

// Grid: col A device, then per part type a CP + TPH column pair. Row1 part headers (merged over 2), row2 site labels.
function rebuildPricesGrid() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SH_PRICES) || ss.insertSheet(SH_PRICES, 0);
  const devices = getDevices().filter(d => d.enabled);
  const grade = getConfigValue('Grade') || 'BQ7';

  // Preserve existing prices keyed by device|part|site
  const existing = {};
  if (sh.getLastRow() > 2) {
    const data = sh.getDataRange().getValues();
    const partRow = data[0], siteRow = data[1];
    for (let r = 2; r < data.length; r++) {
      let curPart = '';
      for (let c = 1; c < data[r].length; c++) {
        if (partRow[c]) curPart = String(partRow[c]).split('|')[0].trim();
        const k = data[r][0] + '|' + curPart + '|' + siteRow[c];
        if (data[r][c] !== '') existing[k] = data[r][c];
      }
    }
  }

  sh.clear();
  const nCols = 1 + PARTS.length * SITES.length;
  const partHdr = ['Device'], siteHdr = [''];
  PARTS.forEach(p => {
    partHdr.push(p.key + ' | ' + p.label.replace('{grade}', grade), '');
    SITES.forEach(s => siteHdr.push(s.label));
  });
  sh.getRange(1, 1, 1, nCols).setValues([partHdr]).setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff');
  sh.getRange(2, 1, 1, nCols).setValues([siteHdr]).setFontWeight('bold').setBackground('#16213e').setFontColor('#a0c4ff');
  for (let i = 0; i < PARTS.length; i++) sh.getRange(1, 2 + i * 2, 1, 2).merge();

  const rows = devices.map(d => {
    const row = [d.name];
    PARTS.forEach(p => SITES.forEach(s => row.push(existing[d.name + '|' + p.key + '|' + s.label] || '')));
    return row;
  });
  if (rows.length) sh.getRange(3, 1, rows.length, nCols).setValues(rows);
  sh.setFrozenRows(2); sh.setFrozenColumns(1);
  sh.setColumnWidth(1, 190);
  for (let c = 2; c <= nCols; c++) sh.setColumnWidth(c, 92);
  // banding for readability
  sh.getRange(3, 1, Math.max(rows.length, 1), nCols).setNumberFormat('@');
}

function menuAddDevice() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Add device', 'Device name (used as search term too):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK || !r.getResponseText().trim()) return;
  const name = r.getResponseText().trim();
  const dv = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_DEVICES);
  dv.appendRow([name, name, '', true]);
  rebuildPricesGrid();
}

function menuClearPrices() {
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('Clear ALL prices?', 'Devices/config are kept.', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_PRICES);
  if (sh.getLastRow() > 2) sh.getRange(3, 2, sh.getLastRow() - 2, sh.getLastColumn() - 1).clearContent().clearNote();
}

// ---------------------------------------------------------------- DATA HELPERS
function getDevices() {
  const dv = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_DEVICES);
  if (!dv || dv.getLastRow() < 2) return [];
  return dv.getRange(2, 1, dv.getLastRow() - 1, 4).getValues()
    .filter(r => r[0])
    .map(r => ({ name: String(r[0]).trim(), search: String(r[1] || r[0]).trim(), aliases: String(r[2] || ''), enabled: r[3] === true || String(r[3]).toUpperCase() === 'TRUE' }));
}

function getConfigValue(name) {
  const cf = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_CONFIG);
  const vals = cf.getRange(2, 1, 10, 2).getValues();
  for (const [k, v] of vals) if (String(k).trim() === name) return v;
  return null;
}

function setConfigValue(name, value) {
  const cf = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_CONFIG);
  const vals = cf.getRange(2, 1, 10, 1).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim() === name) { cf.getRange(2 + i, 2).setValue(value); return true; }
  }
  return false;
}

function getQueries() {
  const cf = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_CONFIG);
  const last = cf.getLastRow();
  if (last < 10) return [];
  return cf.getRange(10, 1, last - 9, 4).getValues()
    .filter(r => r[0])
    .map(r => ({ part: String(r[0]).trim(), template: String(r[1]).trim(), match: String(r[2]).trim(), exclude: String(r[3]).trim() }));
}

// ---------------------------------------------------------------- WEB API
function checkKey_(e) {
  const key = PropertiesService.getScriptProperties().getProperty('KEY') || '';
  return key && e && e.parameter && e.parameter.key === key;
}

// GET ?key=...&action=config  → full config JSON for scrapers
function doGet(e) {
  if (!checkKey_(e)) return json_({ error: 'bad key' });
  const action = (e.parameter.action || 'config');
  if (action === 'config') {
    return json_({
      grade: getConfigValue('Grade'),
      scheduleDay: getConfigValue('Schedule Day'),
      scheduleHour: Number(getConfigValue('Schedule Hour (0-23)')),
      rateLimitMs: Number(getConfigValue('Rate Limit ms')) || 900,
      maxResults: Number(getConfigValue('Max results scanned per search')) || 12,
      devices: getDevices().filter(d => d.enabled),
      queries: getQueries(),
      parts: PARTS.map(p => p.key),
    });
  }
  return json_({ error: 'unknown action' });
}

// POST body JSON:
//  { action:'prices', site:'CP'|'TPH', source:'tm'|'willard',
//    results:[{device, part, price, title, url}] }
//  { action:'setGrade', grade:'AMP' }
//  { action:'log', site, source, message }
function doPost(e) {
  if (!checkKey_(e)) return json_({ error: 'bad key' });
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: 'bad json' }); }

  if (body.action === 'setGrade') {
    setConfigValue('Grade', body.grade);
    rebuildPricesGrid();
    log_(body.source || '?', '', 'Grade changed to ' + body.grade);
    return json_({ ok: true });
  }

  if (body.action === 'log') {
    log_(body.source || '?', body.site || '', body.message || '');
    return json_({ ok: true });
  }

  if (body.action === 'prices') {
    const written = writePrices_(body.site, body.results || []);
    log_(body.source || '?', body.site, 'Wrote ' + written + ' prices (' + (body.results || []).length + ' received)');
    return json_({ ok: true, written: written });
  }
  return json_({ error: 'unknown action' });
}

function writePrices_(siteKey, results) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const site = SITES.find(s => s.key === siteKey);
    if (!site) return 0;
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_PRICES);
    const data = sh.getDataRange().getValues();
    const partRow = data[0], siteRow = data[1];

    // column lookup: part+site → col index
    const colFor = {};
    let curPart = '';
    for (let c = 1; c < partRow.length; c++) {
      if (partRow[c]) curPart = String(partRow[c]).split('|')[0].trim();
      colFor[curPart + '|' + siteRow[c]] = c;
    }
    const rowFor = {};
    for (let r = 2; r < data.length; r++) rowFor[String(data[r][0]).trim().toLowerCase()] = r;

    let n = 0;
    const ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    results.forEach(res => {
      const r = rowFor[String(res.device).trim().toLowerCase()];
      const c = colFor[res.part + '|' + site.label];
      if (r === undefined || c === undefined) return;
      const cell = sh.getRange(r + 1, c + 1);
      cell.setValue(res.price === null || res.price === undefined ? '—' : res.price);
      cell.setNote((res.title || '') + '\n' + (res.url || '') + '\nPulled: ' + ts);
      n++;
    });
    return n;
  } finally {
    lock.releaseLock();
  }
}

function log_(source, site, msg) {
  const lg = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_LOG);
  lg.insertRowAfter(1);
  lg.getRange(2, 1, 1, 4).setValues([[new Date(), source, site, msg]]);
  if (lg.getLastRow() > 500) lg.deleteRows(501, lg.getLastRow() - 500);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
