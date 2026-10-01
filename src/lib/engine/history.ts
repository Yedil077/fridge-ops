import { ENGINE_CONFIG } from "../config/engine";
import type { Fridge, NetworkSnapshot } from "../domain/types";
import { dayNumber, dayOfMonth, daysInMonth, isWeekend, minuteOfDay, weekdayOf } from "../time";

/**
 * Historical intelligence: turns the raw history cube into per-fridge "normal behaviour".
 * Everything here is pure and derived from data — nothing is hand-configured per fridge.
 */

export interface EngineContext {
  snap: NetworkSnapshot;
  F: number;
  C: number;
  P: number;
  D: number;
  today: number;
  nowMinute: number;
  holidays: Set<number>;
  /** F*C*D daily totals */
  catDay: Float32Array;
  /** F*D daily totals */
  fridgeDay: Float32Array;
  /** F*D: 1 if the day is a usable sample: the fridge existed and really sold that day (any hour, any weekday) */
  sample: Uint8Array;
  /** Per history day: recency weight normalised within its bucket (w_bucket / days_in_bucket). */
  dayWeight: Float32Array;
  /** product index lists per category */
  catProducts: number[][];
  bias: (f: number, c: number) => number;
}

/** The fridge existed (and is not deactivated) on that day. Says nothing about hours — those are learned. */
export function fridgeExisted(fr: Fridge, day: number): boolean {
  return fr.isActive && day >= fr.activeSinceDay;
}

/** CONFIGURED working day (Настройки) — only a prior for cold start, never a filter on real sales. */
export function scheduledDay(fr: Fridge, day: number): boolean {
  return fr.workingDays.includes(weekdayOf(day));
}

export function buildContext(snap: NetworkSnapshot, bias: (f: number, c: number) => number = () => 1): EngineContext {
  const F = snap.fridges.length;
  const C = snap.categories.length;
  const P = snap.products.length;
  const D = snap.history.days;
  const { hourly } = snap.history;
  const catDay = new Float32Array(F * C * D);
  const fridgeDay = new Float32Array(F * D);
  for (let f = 0; f < F; f++)
    for (let c = 0; c < C; c++)
      for (let d = 0; d < D; d++) {
        const base = ((f * C + c) * D + d) * 24;
        let s = 0;
        for (let h = 0; h < 24; h++) s += hourly[base + h];
        catDay[(f * C + c) * D + d] = s;
        fridgeDay[f * D + d] += s;
      }
  const holidays = new Set(snap.history.holidays);
  const sample = new Uint8Array(F * D);
  for (let f = 0; f < F; f++)
    for (let d = 0; d < D; d++) {
      const day = snap.history.startDay + d;
      // real sales decide — a Saturday or night sale on a "weekdays 08–20" fridge is a valid sample
      sample[f * D + d] = fridgeExisted(snap.fridges[f], day) && fridgeDay[f * D + d] > 0 ? 1 : 0;
    }

  const today = dayNumber(snap.now);
  const dayWeight = new Float32Array(D);
  const buckets = ENGINE_CONFIG.history.recencyBuckets;
  const counts = buckets.map(() => 0);
  const bucketOf = (age: number) => buckets.findIndex((b) => age <= b.maxAgeDays);
  for (let d = 0; d < D; d++) {
    const b = bucketOf(today - (snap.history.startDay + d));
    if (b >= 0) counts[b]++;
  }
  for (let d = 0; d < D; d++) {
    const b = bucketOf(today - (snap.history.startDay + d));
    dayWeight[d] = b >= 0 && counts[b] > 0 ? buckets[b].weight / counts[b] : 0;
  }

  const catProducts = snap.categories.map((cat) =>
    snap.products.map((p, i) => (p.categoryId === cat.id ? i : -1)).filter((i) => i >= 0),
  );

  return {
    snap, F, C, P, D, today, nowMinute: minuteOfDay(snap.now), holidays,
    catDay, fridgeDay, sample, dayWeight, catProducts, bias,
  };
}

export const histDay = (ctx: EngineContext, d: number) => ctx.snap.history.startDay + d;
export const hourlyAt = (ctx: EngineContext, f: number, c: number, d: number, h: number) =>
  ctx.snap.history.hourly[((f * ctx.C + c) * ctx.D + d) * 24 + h];

// ───────────────────────── weighted statistics ─────────────────────────

interface Sample {
  age: number;
  /** per-hour values (24) */
  hours: ArrayLike<number>;
  total: number;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Recency-weighted hourly mean over samples:
 * mean per bucket, then weighted mean of buckets (empty buckets are dropped and weights renormalised).
 * Outliers (day total > median × cap) are scaled down so one anomaly cannot rewrite the profile.
 */
export function weightedHourlyMean(samples: Sample[]): { hourly: number[]; total: number; n: number } {
  const n = samples.length;
  const hourly = new Array<number>(24).fill(0);
  if (!n) return { hourly, total: 0, n };
  const { recencyBuckets, outlierCapRatio } = ENGINE_CONFIG.history;
  const cap = n >= 4 ? median(samples.map((s) => s.total)) * outlierCapRatio : Infinity;
  const sums = recencyBuckets.map(() => new Array<number>(24).fill(0));
  const cnt = recencyBuckets.map(() => 0);
  for (const s of samples) {
    const b = recencyBuckets.findIndex((x) => s.age <= x.maxAgeDays);
    if (b < 0) continue;
    const scale = s.total > cap && s.total > 0 ? cap / s.total : 1;
    for (let h = 0; h < 24; h++) sums[b][h] += s.hours[h] * scale;
    cnt[b]++;
  }
  let wsum = 0;
  recencyBuckets.forEach((b, i) => {
    if (cnt[i]) wsum += b.weight;
  });
  if (wsum === 0) return { hourly, total: 0, n: 0 };
  recencyBuckets.forEach((b, i) => {
    if (!cnt[i]) return;
    for (let h = 0; h < 24; h++) hourly[h] += (sums[i][h] / cnt[i]) * (b.weight / wsum);
  });
  return { hourly, total: hourly.reduce((a, v) => a + v, 0), n };
}

function collectSamples(
  ctx: EngineContext,
  f: number,
  c: number,
  filter: (day: number, age: number) => boolean,
): Sample[] {
  const out: Sample[] = [];
  for (let d = 0; d < ctx.D; d++) {
    if (!ctx.sample[f * ctx.D + d]) continue;
    const day = histDay(ctx, d);
    const age = ctx.today - day;
    if (!filter(day, age)) continue;
    const base = ((f * ctx.C + c) * ctx.D + d) * 24;
    out.push({ age, hours: ctx.snap.history.hourly.subarray(base, base + 24), total: ctx.catDay[(f * ctx.C + c) * ctx.D + d] });
  }
  return out;
}

function fridgeMeanDaily(ctx: EngineContext, f: number): number {
  let s = 0;
  let n = 0;
  for (let d = 0; d < ctx.D; d++)
    if (ctx.sample[f * ctx.D + d]) {
      s += ctx.fridgeDay[f * ctx.D + d];
      n++;
    }
  return n ? s / n : 0;
}

// ───────────────────────── baseline ─────────────────────────

export interface Baseline {
  /** expected hourly demand on a day the fridge sells (all 24 hours, nothing masked) */
  hourly: number[];
  /** P(the fridge sells at all on this weekday), learned; configured schedule is a weak prior */
  pOpen: number;
  nSameWeekday: number;
  nDayType: number;
  networkWeight: number;
  label: string;
  cv: number;
}

const baselineCache = new WeakMap<EngineContext, Map<string, Baseline>>();

/**
 * Normal hourly demand of category c at fridge f for `day`:
 * A (same weekday) → B (same day type, 90 d) → C (similar locations / network), blended by shrinkage.
 */
export function baselineFor(ctx: EngineContext, f: number, c: number, day = ctx.today): Baseline {
  let cache = baselineCache.get(ctx);
  if (!cache) baselineCache.set(ctx, (cache = new Map()));
  const key = `${f}:${c}:${day}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const wd = weekdayOf(day);
  const weekend = isWeekend(wd);
  const { sameWeekdayK, dayTypeK } = ENGINE_CONFIG.history;

  const A = weightedHourlyMean(collectSamples(ctx, f, c, (d) => weekdayOf(d) === wd));
  const B = weightedHourlyMean(collectSamples(ctx, f, c, (d, age) => age <= 90 && isWeekend(weekdayOf(d)) === weekend));
  const wA = A.n / (A.n + sameWeekdayK);
  const wB = B.n / (B.n + dayTypeK);
  const netW = (1 - wA) * (1 - wB);

  let net = new Array<number>(24).fill(0);
  if (netW > 0.005) net = networkHourly(ctx, f, c, wd);

  // every hour 00–23 comes from data; no hour is zeroed because of a configured schedule
  const hourly = new Array<number>(24);
  for (let h = 0; h < 24; h++) hourly[h] = wA * A.hourly[h] + (1 - wA) * (wB * B.hourly[h] + (1 - wB) * net[h]);

  // variability of daily totals on same-weekday samples
  const totals = collectSamples(ctx, f, c, (d, age) => weekdayOf(d) === wd && age <= 120).map((s) => s.total);
  let cv = 0.35;
  if (totals.length >= 3) {
    const m = totals.reduce((a, b) => a + b, 0) / totals.length;
    const v = totals.reduce((a, b) => a + (b - m) ** 2, 0) / (totals.length - 1);
    cv = m > 0 ? Math.sqrt(Math.max(0, v - m)) / m : 0.5; // subtract Poisson part
    cv = Math.min(0.8, Math.max(0.05, cv));
  }

  const label =
    netW > 0.25
      ? "Сеть + похожие точки (мало данных)"
      : netW > 0.05
        ? `Своя история (${A.n} дн.) + похожие точки ${Math.round(netW * 100)}%`
        : A.n >= 4
        ? `История: ${A.n} аналогичных дней недели`
        : `История: ${B.n} дней того же типа`;
  const res: Baseline = { hourly, pOpen: openProbability(ctx, f, day), nSameWeekday: A.n, nDayType: B.n, networkWeight: netW, label, cv };
  cache.set(key, res);
  return res;
}

/**
 * P(the fridge sells on `day`'s weekday) = (days with sales + k·prior) / (calendar days + k).
 * prior = 1 if the configured schedule says open, small otherwise — history wins as soon as it exists.
 */
export function openProbability(ctx: EngineContext, f: number, day: number): number {
  const fr = ctx.snap.fridges[f];
  if (!fridgeExisted(fr, day)) return 0;
  const wd = weekdayOf(day);
  let cal = 0;
  let open = 0;
  for (let d = 0; d < ctx.D; d++) {
    const hd = histDay(ctx, d);
    if (weekdayOf(hd) !== wd || !fridgeExisted(fr, hd) || ctx.today - hd > 120) continue;
    cal++;
    if (ctx.sample[f * ctx.D + d]) open++;
  }
  const k = ENGINE_CONFIG.activity.schedulePriorDays;
  const prior = scheduledDay(fr, day) ? 1 : 0.15;
  return (open + k * prior) / (cal + k);
}

/** Network baseline scaled to the fridge's volume (cold start). The hour shape comes from peers' real sales. */
function networkHourly(ctx: EngineContext, f: number, c: number, wd: number): number[] {
  const fr = ctx.snap.fridges[f];
  const similar = ctx.snap.fridges
    .map((x, i) => ({ x, i }))
    .filter(({ x, i }) => i !== f && x.locationType === fr.locationType);
  const peers = similar.length >= 2 ? similar : ctx.snap.fridges.map((x, i) => ({ x, i })).filter(({ i }) => i !== f);
  const ownVolume = fridgeMeanDaily(ctx, f);
  const acc = new Array<number>(24).fill(0);
  let used = 0;
  for (const { i } of peers) {
    const s = weightedHourlyMean(collectSamples(ctx, i, c, (d) => weekdayOf(d) === wd));
    if (!s.n) continue;
    const peerVolume = fridgeMeanDaily(ctx, i);
    const ratio = ownVolume > 0 && peerVolume > 0 ? ownVolume / peerVolume : 1;
    for (let h = 0; h < 24; h++) acc[h] += s.hourly[h] * ratio;
    used++;
  }
  return used ? acc.map((v) => v / used) : acc;
}

// ───────────────────────── corrections ─────────────────────────

/** Mild correction when the recent level differs from the weighted history (trend detection). */
export function trendFactor(ctx: EngineContext, f: number, c: number): number {
  const { trendWindowDays, trendMin, trendMax } = ENGINE_CONFIG.history;
  let rs = 0, rn = 0, ws = 0, ww = 0;
  for (let d = 0; d < ctx.D; d++) {
    if (!ctx.sample[f * ctx.D + d]) continue;
    const v = ctx.catDay[(f * ctx.C + c) * ctx.D + d];
    const age = ctx.today - histDay(ctx, d);
    if (age <= trendWindowDays) {
      rs += v;
      rn++;
    }
    ws += v * ctx.dayWeight[d];
    ww += ctx.dayWeight[d];
  }
  if (rn < 8 || ww === 0 || ws === 0) return 1;
  const ratio = rs / rn / (ws / ww);
  return Math.min(trendMax, Math.max(trendMin, 1 + 0.5 * (ratio - 1)));
}

/** Start / end of month effect learned from history. */
export function monthPhaseFactor(ctx: EngineContext, f: number, day = ctx.today): number {
  const dom = dayOfMonth(day);
  const dim = daysInMonth(day);
  const phase = (d: number) => {
    const x = dayOfMonth(d);
    return x <= 3 ? "start" : x >= daysInMonth(d) - 2 ? "end" : "mid";
  };
  const target = dom <= 3 ? "start" : dom >= dim - 2 ? "end" : "mid";
  if (target === "mid") return 1;
  let ps = 0, pn = 0, ms = 0, mn = 0;
  for (let d = 0; d < ctx.D; d++) {
    if (!ctx.sample[f * ctx.D + d]) continue;
    const day0 = histDay(ctx, d);
    const v = ctx.fridgeDay[f * ctx.D + d];
    const ph = phase(day0);
    if (ph === target) {
      ps += v;
      pn++;
    } else if (ph === "mid") {
      ms += v;
      mn++;
    }
  }
  if (pn < 4 || mn < 10 || ms === 0) return 1;
  const { monthPhaseMin, monthPhaseMax } = ENGINE_CONFIG.history;
  return Math.min(monthPhaseMax, Math.max(monthPhaseMin, ps / pn / (ms / mn)));
}

// ───────────────────────── helpers used by explanations & profiles ─────────────────────────

/**
 * Sales in [fromMin, toMin) on the last n same-weekday days with sales, most recent first.
 * toMin > 1440 continues into the following calendar day (e.g. 23:20–00:50).
 */
export function sameWeekdayWindowSales(ctx: EngineContext, f: number, c: number, fromMin: number, toMin: number, n = 4): number[] {
  const wd = weekdayOf(ctx.today);
  const out: number[] = [];
  const part = (d: number, from: number, to: number) => {
    if (d < 0 || d >= ctx.D) return 0;
    let s = 0;
    for (let h = 0; h < 24; h++) {
      const overlap = Math.max(0, Math.min(to, h * 60 + 60) - Math.max(from, h * 60)) / 60;
      if (overlap > 0) s += hourlyAt(ctx, f, c, d, h) * overlap;
    }
    return s;
  };
  for (let d = ctx.D - 1; d >= 0 && out.length < n; d--) {
    if (!ctx.sample[f * ctx.D + d] || weekdayOf(histDay(ctx, d)) !== wd) continue;
    let s = part(d, fromMin, Math.min(toMin, 1440));
    if (toMin > 1440) s += part(d + 1, 0, toMin - 1440);
    out.push(Math.round(s));
  }
  return out;
}

/** Same-weekday daily totals of a fridge (for anomaly detection). */
export function typicalDay(ctx: EngineContext, f: number): { mean: number; std: number; n: number } {
  const wd = weekdayOf(ctx.today);
  const vals: number[] = [];
  for (let d = 0; d < ctx.D; d++) {
    if (!ctx.sample[f * ctx.D + d] || weekdayOf(histDay(ctx, d)) !== wd) continue;
    if (ctx.today - histDay(ctx, d) > 120) continue;
    vals.push(ctx.fridgeDay[f * ctx.D + d]);
  }
  if (!vals.length) return { mean: 0, std: 0, n: 0 };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const std = vals.length > 1 ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1)) : mean * 0.3;
  return { mean, std, n: vals.length };
}

/** Product share inside a category at a fridge (last 30 working days, smoothed toward the network). */
export function productShares(ctx: EngineContext, f: number, c: number): Map<number, number> {
  const prods = ctx.catProducts[c];
  const own = prods.map(() => 0);
  const net = prods.map(() => 0);
  const { productDaily } = ctx.snap.history;
  for (let d = Math.max(0, ctx.D - 30); d < ctx.D; d++) {
    prods.forEach((p, k) => {
      for (let g = 0; g < ctx.F; g++) {
        const v = productDaily[(g * ctx.P + p) * ctx.D + d];
        net[k] += v;
        if (g === f) own[k] += v;
      }
    });
  }
  const ownSum = own.reduce((a, b) => a + b, 0);
  const netSum = net.reduce((a, b) => a + b, 0) || 1;
  const prior = 10;
  const out = new Map<number, number>();
  prods.forEach((p, k) => out.set(p, (own[k] + prior * (net[k] / netSum)) / (ownSum + prior)));
  return out;
}
