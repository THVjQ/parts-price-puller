/**
 * Live config loader — reads config/*.yml and hot-reloads them.
 *
 * The whole point of this file: someone edits devices.yml on GitHub, the git-sync
 * loop pulls it onto the box, and the running site picks it up without a restart.
 *
 * Two rules that make that safe:
 *  1. Polling, not inotify. Config arrives via a bind mount that a *different*
 *     process (git) rewrites — inotify across a Docker bind mount misses those.
 *  2. A broken YAML never takes the site down. Parse failures keep the last good
 *     config in memory and surface the error on /api/health instead.
 */
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const FILES = ['devices.yml', 'parts.yml', 'stores.yml', 'settings.yml'];

let current = null;      // last GOOD config
let stamp = '';          // mtime+size fingerprint the good config was built from
let lastError = null;    // {file, message, at} of the most recent failed reload
let loadedAt = null;
const listeners = [];

// Fingerprint of all config files — cheap enough to run every few seconds.
function fingerprint() {
  return FILES.map(f => {
    try {
      const s = fs.statSync(path.join(CONFIG_DIR, f));
      return `${f}:${s.mtimeMs}:${s.size}`;
    } catch (e) {
      return `${f}:missing`;
    }
  }).join('|');
}

function readYaml(file) {
  const p = path.join(CONFIG_DIR, file);
  const txt = fs.readFileSync(p, 'utf8');
  return YAML.parse(txt) || {};
}

// `exclude: [oled, *accessories]` aliases a whole list into a list — flatten it back out.
const flat = a => (Array.isArray(a) ? a.flat(Infinity).filter(x => x != null).map(String) : []);
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

function build() {
  const devicesDoc  = readYaml('devices.yml');
  const partsDoc    = readYaml('parts.yml');
  const storesDoc   = readYaml('stores.yml');
  const settingsDoc = readYaml('settings.yml');

  const groups = (devicesDoc.groups || []).map(g => ({ id: String(g.id), label: String(g.label || g.id) }));
  const devices = (devicesDoc.devices || [])
    .filter(d => d && d.name)
    .map(d => ({
      name: String(d.name).trim(),
      search: String(d.search || d.name).trim(),
      group: String(d.group || 'other'),
      aliases: flat(d.aliases),
      enabled: d.enabled !== false,
    }));

  const parts = (partsDoc.parts || [])
    .filter(p => p && p.key)
    .map(p => ({
      key: String(p.key).trim(),
      label: String(p.label || p.key),
      graded: p.graded === true,
      query: String(p.query || '{device} ' + p.key),
      must: flat(p.must),
      exclude: flat(p.exclude),
    }));

  const grades = {
    list: flat((settingsDoc.grades || {}).list).length ? flat((settingsDoc.grades || {}).list) : ['BQ7'],
    default: String((settingsDoc.grades || {}).default || 'BQ7'),
  };
  if (!grades.list.includes(grades.default)) grades.list.unshift(grades.default);

  const sources = (settingsDoc.sources || [])
    .filter(s => s && s.key)
    .map(s => ({
      key: String(s.key).trim(),
      label: String(s.label || s.key),
      url: String(s.url || ''),
      scraper: s.scraper === true,
      enabled: s.enabled !== false,
    }));

  const stores = (storesDoc.stores || [])
    .filter(s => s && (s.id || s.name))
    .map(s => ({
      id: slug(s.id || s.name),
      name: String(s.name || s.id),
      calculator: normaliseCalculator(s.calculator || storesDoc.defaults || {}),
    }));

  const site = settingsDoc.site || {};
  const schedule = settingsDoc.schedule || {};
  const pull = settingsDoc.pull || {};
  const retention = settingsDoc.retention || {};

  return {
    groups, devices, parts, grades, sources, stores,
    site: {
      title: String(site.title || 'Parts Pricing'),
      subtitle: String(site.subtitle || ''),
      currency: String(site.currency || '$'),
      gstPercent: num(site.gstPercent, 10),
    },
    schedule: {
      day: String(schedule.day || 'Sunday'),
      hour: num(schedule.hour, 0),
      timezone: String(schedule.timezone || process.env.TZ || 'Australia/Sydney'),
    },
    pull: {
      rateLimitMs: num(pull.rateLimitMs, 900),
      maxResults: num(pull.maxResults, 12),
    },
    retention: {
      priceHistoryDays: num(retention.priceHistoryDays, 400),
      logRows: num(retention.logRows, 2000),
    },
    storeSeeds: stores,
  };
}

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

// Accept a partly-filled calculator and return a complete, valid one.
function normaliseCalculator(c) {
  c = c && typeof c === 'object' ? c : {};
  const r = c.rounding && typeof c.rounding === 'object' ? c.rounding : {};
  const tiers = (Array.isArray(c.tiers) ? c.tiers : [])
    .filter(t => t && t.markupPercent != null)
    .map(t => ({
      upTo: t.upTo == null || t.upTo === '' ? null : num(t.upTo, null),
      markupPercent: num(t.markupPercent, 0),
    }));
  return {
    mode: c.mode === 'flat' ? 'flat' : (tiers.length ? 'tiers' : 'flat'),
    markupPercent: num(c.markupPercent, 60),
    tiers: tiers.length ? tiers : [{ upTo: null, markupPercent: num(c.markupPercent, 60) }],
    labour: num(c.labour, 0),
    gst: c.gst !== false,
    rounding: {
      mode: ['none', 'nearest', 'up', 'down'].includes(r.mode) ? r.mode : 'none',
      step: num(r.step, 5) > 0 ? num(r.step, 5) : 5,
      endsWith: r.endsWith == null || r.endsWith === '' ? null : num(r.endsWith, null),
    },
  };
}

/** Current config. Re-reads from disk only when a file actually changed. */
function get() {
  const fp = fingerprint();
  if (current && fp === stamp) return current;
  try {
    const next = build();
    current = next;
    stamp = fp;
    loadedAt = new Date().toISOString();
    lastError = null;
    listeners.forEach(fn => { try { fn(current); } catch (e) { console.error('config listener:', e.message); } });
    console.log(`[config] loaded ${next.devices.length} devices, ${next.parts.length} parts, ${next.storeSeeds.length} stores`);
  } catch (e) {
    lastError = { message: e.message, at: new Date().toISOString() };
    console.error('[config] RELOAD FAILED — keeping last good config:', e.message);
    if (!current) throw e;   // nothing good to fall back on: refuse to start
    stamp = fp;              // don't spam-retry the same broken files every tick
  }
  return current;
}

function onChange(fn) { listeners.push(fn); }
function status() { return { loadedAt, error: lastError, dir: CONFIG_DIR }; }

/** Force a re-read on the next get() — used after a git pull. */
function invalidate() { stamp = ''; }

function startWatching(intervalMs) {
  get();
  const t = setInterval(get, Math.max(1000, intervalMs || 5000));
  t.unref?.();
  return t;
}

module.exports = { get, onChange, status, invalidate, startWatching, normaliseCalculator, CONFIG_DIR };
