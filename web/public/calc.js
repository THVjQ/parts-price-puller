/**
 * Retail calculator — ONE implementation, used by both the browser (live preview in
 * the editor, retail column in the matrix) and the server (/api/prices retail values).
 * Loaded as a <script> in the page and require()d by server.js, so the two can never
 * drift apart and disagree about what a store charges.
 *
 * THE FORMULA
 *   retail = cost × multiply%  + add
 *   …and if a threshold is set and cost is OVER it:
 *   retail = cost × overMultiply% + overAdd
 *
 * multiply% carries GST: 110 means "+10% GST", 130 means "GST plus a 20% margin on
 * the part". `add` is the labour/fitting component.
 *
 * RULES ARE PER DEVICE-GROUP × PART, with inheritance, so iPhone screens can price
 * differently from Samsung A batteries without filling in 40 boxes:
 *
 *      "*|*"            every part on every device        (the base rule)
 *      "iphone|*"       every iPhone part
 *      "*|LCD"          LCD on every device family
 *      "iphone|LCD"     the specific one — wins
 *
 * Any field left null on a more specific rule inherits from the less specific one.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PPPCalc = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FIELDS = ['multiplyPercent', 'add', 'threshold', 'overMultiplyPercent', 'overAdd'];
  const BASE = { multiplyPercent: 110, add: 0, threshold: null, overMultiplyPercent: null, overAdd: null };

  const num = v => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));

  /** Strip a rule down to the fields that are actually set. */
  function cleanRule(r) {
    const out = {};
    if (!r || typeof r !== 'object') return out;
    for (const f of FIELDS) {
      const v = num(r[f]);
      if (v != null) out[f] = v;
    }
    return out;
  }

  const keyFor = (group, part) => String(group || '*') + '|' + String(part || '*');

  /** Merge the four levels of rule that can apply to one cell, least specific first. */
  function resolveRule(calc, group, part) {
    const rules = (calc && calc.rules) || {};
    const merged = Object.assign({}, BASE);
    for (const k of ['*|*', keyFor(group, '*'), keyFor('*', part), keyFor(group, part)]) {
      const r = rules[k];
      if (!r) continue;
      for (const f of FIELDS) if (num(r[f]) != null) merged[f] = num(r[f]);
    }
    return merged;
  }

  /** Which rule key actually supplied the values — shown in the UI as "inherited from". */
  function rulePath(calc, group, part) {
    const rules = (calc && calc.rules) || {};
    return ['*|*', keyFor(group, '*'), keyFor('*', part), keyFor(group, part)]
      .filter(k => rules[k] && Object.keys(cleanRule(rules[k])).length);
  }

  function applyRounding(value, rounding) {
    const r = rounding || {};
    let v = value;
    const step = Number(r.step) > 0 ? Number(r.step) : 5;
    if (r.mode === 'nearest') v = Math.round(v / step) * step;
    else if (r.mode === 'up') v = Math.ceil(v / step) * step;
    else if (r.mode === 'down') v = Math.floor(v / step) * step;

    if (r.endsWith != null && r.endsWith !== '') {
      // Snap to the NEAREST price with these cents, e.g. 0.99 turns 150 into 149.99
      // and 150.60 into 150.99.
      const cents = Number(r.endsWith);
      const lo = Math.floor(v - cents + 1e-9) + cents;   // largest x.cents at or below v
      const hi = lo + 1;
      v = (v - lo) <= (hi - v) ? lo : hi;
    }
    return v;
  }

  /** Apply one resolved rule to a cost. */
  function priceFromRule(cost, rule, rounding) {
    const c = Number(cost);
    if (!isFinite(c) || c <= 0) return null;
    const over = rule.threshold != null && c > rule.threshold;
    const mult = over && rule.overMultiplyPercent != null ? rule.overMultiplyPercent : rule.multiplyPercent;
    const add = over ? (rule.overAdd != null ? rule.overAdd : rule.add) : rule.add;
    const v = applyRounding(c * (Number(mult) || 0) / 100 + (Number(add) || 0), rounding);
    return Math.round(v * 100) / 100;
  }

  /**
   * @param wholesale ex-GST supplier cost
   * @param calc      the store's calculator
   * @param group     device group id, e.g. "iphone"
   * @param part      part key, e.g. "LCD"
   */
  function computeRetail(wholesale, calc, group, part) {
    if (!calc) return null;
    return priceFromRule(wholesale, resolveRule(calc, group, part), calc.rounding);
  }

  /**
   * Margin on the sale as a % of the ex-GST retail price. The multiplier already
   * includes GST, so back it out before comparing with the ex-GST cost.
   */
  function marginPercent(wholesale, retail, gstPercent) {
    const w = Number(wholesale), r = Number(retail);
    if (!isFinite(w) || !isFinite(r) || r <= 0) return null;
    const exGst = r / (1 + (Number(gstPercent) || 0) / 100);
    if (exGst <= 0) return null;
    return Math.round(((exGst - w) / exGst) * 1000) / 10;
  }

  /** Human summary of a rule, for the editor's "what does this do" line. */
  function describeRule(rule, currency) {
    const c = currency || '$';
    const money = n => c + (Number(n) % 1 ? Number(n).toFixed(2) : Number(n));
    let s = `cost × ${rule.multiplyPercent}%` + (rule.add ? ` + ${money(rule.add)}` : '');
    if (rule.threshold != null) {
      const m = rule.overMultiplyPercent != null ? rule.overMultiplyPercent : rule.multiplyPercent;
      const a = rule.overAdd != null ? rule.overAdd : rule.add;
      s += `, over ${money(rule.threshold)}: cost × ${m}%` + (a ? ` + ${money(a)}` : '');
    }
    return s;
  }

  return { computeRetail, priceFromRule, resolveRule, rulePath, cleanRule, keyFor, marginPercent, applyRounding, describeRule, FIELDS, BASE };
}));
