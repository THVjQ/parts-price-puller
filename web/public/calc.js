/**
 * Retail calculator — ONE implementation, used by both the browser (live preview in
 * the editor, retail column in the matrix) and the server (/api/prices retail values).
 * Loaded as a <script> in the page and require()d by server.js, so the two can never
 * drift apart and disagree about what a store charges.
 *
 *   retail = round( wholesale × (1 + markup%) + labour )  [× (1 + GST%)]
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PPPCalc = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function markupFor(calc, wholesale) {
    if (!calc) return 0;
    if (calc.mode === 'flat' || !Array.isArray(calc.tiers) || !calc.tiers.length) {
      return Number(calc.markupPercent) || 0;
    }
    // First tier whose ceiling covers this cost. upTo: null = "and everything above".
    for (const t of calc.tiers) {
      if (t.upTo == null || wholesale <= Number(t.upTo)) return Number(t.markupPercent) || 0;
    }
    const last = calc.tiers[calc.tiers.length - 1];
    return Number(last.markupPercent) || 0;
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

  /**
   * @param wholesale ex-GST supplier cost
   * @param calc      store calculator
   * @param gstPercent site-wide GST, applied only when calc.gst is true
   * @returns number | null
   */
  function computeRetail(wholesale, calc, gstPercent) {
    const w = Number(wholesale);
    if (!isFinite(w) || w <= 0 || !calc) return null;
    let v = w * (1 + markupFor(calc, w) / 100) + (Number(calc.labour) || 0);
    if (calc.gst) v = v * (1 + (Number(gstPercent) || 0) / 100);
    v = applyRounding(v, calc.rounding);
    return Math.round(v * 100) / 100;
  }

  /** Margin on a sale, as a % of the retail price (ex-GST both sides). */
  function marginPercent(wholesale, retail, calc, gstPercent) {
    const w = Number(wholesale), r = Number(retail);
    if (!isFinite(w) || !isFinite(r) || r <= 0) return null;
    const exGst = calc && calc.gst ? r / (1 + (Number(gstPercent) || 0) / 100) : r;
    if (exGst <= 0) return null;
    return Math.round(((exGst - w) / exGst) * 1000) / 10;
  }

  return { computeRetail, marginPercent, markupFor, applyRounding };
}));
