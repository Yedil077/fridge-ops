import type { KsStockChange } from "./dataset";

/**
 * When was a dish on the shelf? Stock over time for every dish of ONE fridge, built from real KiT Shop data only:
 *  • periods covered by the 5-minute stock history (GetShopStocks change log) — taken as they are;
 *  • everything else, back to `validFrom`, reconstructed BACKWARDS from the next known stock:
 *      stock before a sale = stock after + qty sold;  stock before a load / unload = stock after − its quantity.
 *    Valid only where every receipt has its lines and every load / unload is known (validFrom). A step that would make the
 *    stock negative means KiT Shop has a movement we cannot see (e.g. a correction) → clamped to 0 and counted.
 * Per day the result is:
 *  • avail — share of the fridge's sales (all dishes) made while this dish had stock > 0 (1 = there all day; a closed night
 *    does not count, because nobody buys anything then). NaN = stock not known for the whole day;
 *  • ranOut — times a sale took the last unit; eod — stock at the end of the day.
 */

export interface TimelineInput {
  /** product lines of complete receipts at this fridge: time, product, qty */
  sales: { at: number; productId: string; qty: number }[];
  /** lines of loads / unloads with a known time: qty > 0 load, < 0 taken out */
  fills: { at: number; productId: string; qty: number }[];
  /** stock history (change log) and the periods it covers */
  history: Map<string, KsStockChange[]>;
  coverage: [number, number][];
  /** latest stock reading and its time */
  current: Map<string, number>;
  currentAt: number;
  /** reconstruction is trusted only after this moment (wall-clock ms); Infinity = no reconstruction, stock history only */
  validFrom: number;
  startDay: number;
  days: number;
}

export interface DishDays {
  avail: Float32Array;
  ranOut: Uint8Array;
  eod: Float32Array;
}

export interface TimelineResult {
  dishes: Map<string, DishDays>;
  /** reconstruction steps clamped at 0 (movements KiT Shop does not show) */
  fixes: number;
}

const DAY = 86_400_000;

interface Interval {
  from: number;
  to: number;
  qty: number;
}

/** Fridge sales as a cumulative curve: units sold in (t0, t1]. */
function salesCurve(sales: { at: number; qty: number }[]) {
  const sorted = [...sales].sort((a, b) => a.at - b.at);
  const times = sorted.map((s) => s.at);
  const cum = new Float64Array(sorted.length + 1);
  sorted.forEach((s, i) => (cum[i + 1] = cum[i] + s.qty));
  // index of the first sale with time > t
  const upper = (t: number) => {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (times[m] <= t) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  return (t0: number, t1: number) => (t1 <= t0 ? 0 : cum[upper(t1)] - cum[upper(t0)]);
}

export function buildTimeline(inp: TimelineInput): TimelineResult {
  const { startDay, days } = inp;
  const t0 = startDay * DAY;
  const tEnd = (startDay + days) * DAY;
  const unitsIn = salesCurve(inp.sales);
  const dayUnits = new Float64Array(days);
  for (let d = 0; d < days; d++) dayUnits[d] = unitsIn(t0 + d * DAY, t0 + (d + 1) * DAY);

  // events per dish
  const group = (rows: { at: number; productId: string; qty: number }[]) => {
    const m = new Map<string, { at: number; qty: number }[]>();
    for (const r of rows) {
      const list = m.get(r.productId) ?? [];
      list.push({ at: r.at, qty: r.qty });
      m.set(r.productId, list);
    }
    return m;
  };
  const salesBy = group(inp.sales);
  const fillsBy = group(inp.fills);
  const dishes = new Set<string>([...salesBy.keys(), ...fillsBy.keys(), ...inp.history.keys(), ...inp.current.keys()]);

  const coverage = [...inp.coverage].sort((a, b) => a[0] - b[0]);
  let fixes = 0;
  const out = new Map<string, DishDays>();

  for (const pid of dishes) {
    const hist = inp.history.get(pid) ?? [];
    const sales = salesBy.get(pid) ?? [];
    const fills = fillsBy.get(pid) ?? [];
    // stock at time t inside a covered period [a, b]: last change in [a, t], otherwise 0 (a period starts with the full state)
    const histAt = (a: number, t: number) => {
      let q = 0;
      for (const h of hist) {
        if (h.at < a) continue;
        if (h.at > t) break;
        q = h.qty;
      }
      return q;
    };
    const intervals: Interval[] = [];
    const ranOutAt: number[] = [];

    // 1. covered periods
    for (const [a, b] of coverage) {
      let from = a;
      let q = histAt(a, a);
      for (const h of hist) {
        if (h.at <= a || h.at > b) continue;
        if (h.qty !== q) {
          intervals.push({ from, to: h.at, qty: q });
          // sold out between two readings, not taken out by an unload
          if (h.qty <= 0 && q > 0 && !fills.some((f) => f.qty < 0 && f.at > from && f.at <= h.at)) ranOutAt.push(h.at);
          from = h.at;
          q = h.qty;
        }
      }
      intervals.push({ from, to: b, qty: q });
    }

    // 2. gaps, reconstructed backwards from the stock known at their end
    const gaps: { from: number; to: number; endQty: number }[] = [];
    let prevEnd = -Infinity;
    for (const [a, b] of coverage) {
      gaps.push({ from: prevEnd, to: a, endQty: histAt(a, a) });
      prevEnd = b;
    }
    gaps.push({ from: prevEnd, to: inp.currentAt, endQty: inp.current.get(pid) ?? 0 });
    for (const g of gaps) {
      const from = Math.max(g.from, inp.validFrom);
      if (g.to <= from) continue;
      const events = [
        ...sales.filter((s) => s.at >= from && s.at < g.to).map((s) => ({ at: s.at, delta: -s.qty, sale: true })),
        ...fills.filter((f) => f.at >= from && f.at < g.to).map((f) => ({ at: f.at, delta: f.qty, sale: false })),
      ].sort((x, y) => y.at - x.at);
      let cur = g.endQty;
      let end = g.to;
      for (const e of events) {
        intervals.push({ from: e.at, to: end, qty: cur });
        let before = cur - e.delta;
        if (before < 0) {
          fixes++;
          before = 0;
        }
        if (e.sale && cur <= 0 && before > 0) ranOutAt.push(e.at);
        cur = before;
        end = e.at;
      }
      intervals.push({ from, to: end, qty: cur });
    }

    // 3. per day
    const avail = new Float32Array(days).fill(NaN);
    const eod = new Float32Array(days).fill(NaN);
    const ranOut = new Uint8Array(days);
    const known = new Float64Array(days);
    const outUnits = new Float64Array(days);
    for (const iv of intervals) {
      const a = Math.max(iv.from, t0);
      const b = Math.min(iv.to, tEnd);
      if (b <= a) continue;
      for (let d = Math.floor((a - t0) / DAY); d < days && t0 + d * DAY < b; d++) {
        const da = Math.max(a, t0 + d * DAY);
        const db = Math.min(b, t0 + (d + 1) * DAY);
        if (db <= da) continue;
        known[d] += db - da;
        if (iv.qty <= 0) outUnits[d] += unitsIn(da, db);
        // stock at the end of the day: the interval that covers 23:59:59
        if (db >= t0 + (d + 1) * DAY - 1000) eod[d] = Math.max(0, iv.qty);
      }
    }
    for (let d = 0; d < days; d++) {
      // a day counts only when stock is known for (almost) all of it
      if (known[d] < DAY * 0.97) {
        eod[d] = NaN;
        continue;
      }
      if (dayUnits[d] > 0) avail[d] = Math.max(0, 1 - outUnits[d] / dayUnits[d]);
    }
    for (const t of ranOutAt) {
      const d = Math.floor((t - t0) / DAY);
      if (d >= 0 && d < days && known[d] >= DAY * 0.97 && ranOut[d] < 255) ranOut[d]++;
    }
    out.set(pid, { avail, ranOut, eod });
  }
  return { dishes: out, fixes };
}
