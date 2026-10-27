import { ENGINE_CONFIG } from "../config/engine";
import type { CategoryId, FridgeForecast } from "../domain/types";
import { fmtHM, weekdayOf } from "../time";
import { activityProfile } from "./activity";
import { sumAcross } from "./forecast";
import { histDay, type EngineContext } from "./history";
import type { DemandIndexRow } from "../domain/types";
import type { DemandCell, Horizon } from "./demand";

/**
 * FRIDGE PROFILE — what is NORMAL for one fridge, learned from its own 180 days, and where today stands.
 *  • the norm is individual: 50 sales can be "a lot" at one point and "low" at another;
 *  • recent weeks weigh more (last 7 days > last 30 > older), same weekday, same hour, 00–23 (night included);
 *  • one strange day does not become the norm: the range is a weighted 25–75 % band, and a day far outside it is ANOMALY;
 *  • every conclusion carries its numbers, and the profile has a confidence.
 * Pure function over the engine context + forecasts: no I/O.
 */

export type DayStatus = "NORMAL" | "ABOVE" | "BELOW" | "ANOMALY" | "QUIET" | "NO_DATA";
export type DemandLevel = "HIGH" | "NORMAL" | "LOW";
export type StockStatus = "LOW" | "OK" | "SURPLUS";

export interface Range {
  low: number;
  high: number;
  avg: number;
}

export interface CategoryProfile {
  id: CategoryId;
  name: string;
  emoji: string;
  /** 1.00 = network average share */
  index: number;
  vsNetworkPct: number;
  demand: DemandLevel;
  stock: number;
  /** expected demand, horizon NOW (~90 min) — engine/demand.ts */
  expectedNow: number;
  /** expected demand until the evening time — engine/demand.ts */
  untilEvening: number;
  projectedEvening: number;
  status: StockStatus;
  /** need_quantity, horizon NOW — the SAME number the transfer recommendation uses */
  need: number;
  /** safe_surplus, horizon NOW — the SAME number the transfer recommendation uses */
  canGive: number;
  /** plain reason from the demand module */
  reason: string;
}

export interface ProductAffinity {
  productIndex: number;
  perDay: number;
  /** share of this dish at the fridge ÷ its share in the network; 1.00 = average */
  affinity: number;
}

export interface FridgeProfile {
  fridgeIndex: number;
  dataDays: number;
  confidence: number;
  normalDay: Range;
  normalByNow: Range;
  today: { sales: number; deviationPct: number | null; status: DayStatus; label: string };
  peaks: { from: number; to: number }[];
  /** Mon..Sun, 1.00 = average of the weekdays it sells on; 0 = no sales that weekday */
  weekdayIndex: number[];
  strongWeekdays: number[];
  weakWeekdays: number[];
  nightShare: number;
  eveningShare: number;
  morningShare: number;
  categories: CategoryProfile[];
  topProducts: ProductAffinity[];
  tags: { emoji: string; label: string }[];
  /** plain conclusions, most important first */
  summary: string[];
}

/** "обычно по …" */
const DAY_DATIVE = ["понедельникам", "вторникам", "средам", "четвергам", "пятницам", "субботам", "воскресеньям"];
const DAY_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const TAG_HIGH: Record<CategoryId, string> = {
  breakfast: "ЛЮБЯТ ЗАВТРАКИ",
  hot: "ЛЮБЯТ ГОРЯЧЕЕ",
  salad: "ЛЮБЯТ САЛАТЫ",
  snack: "ЛЮБЯТ ПЕРЕКУСЫ",
  dessert: "ЛЮБЯТ ДЕСЕРТЫ",
  drink: "ЛЮБЯТ НАПИТКИ",
};
const TAG_LOW: Record<CategoryId, string> = {
  breakfast: "МАЛО ЗАВТРАКОВ",
  hot: "МАЛО ГОРЯЧЕГО",
  salad: "МАЛО САЛАТОВ",
  snack: "МАЛО ПЕРЕКУСОВ",
  dessert: "МАЛО ДЕСЕРТОВ",
  drink: "МАЛО НАПИТКОВ",
};

/** weight of a history day by age: last 7 days > last 30 > 90 > 180 (same buckets as the forecast) */
const recencyWeight = (age: number) => ENGINE_CONFIG.history.recencyBuckets.find((b) => age <= b.maxAgeDays)?.weight ?? 0;

/** weighted quantile; values with weights */
export function weightedQuantile(points: { v: number; w: number }[], q: number): number {
  const pts = points.filter((p) => p.w > 0).sort((a, b) => a.v - b.v);
  if (!pts.length) return 0;
  const total = pts.reduce((a, p) => a + p.w, 0);
  let acc = 0;
  for (const p of pts) {
    acc += p.w;
    if (acc >= q * total) return p.v;
  }
  return pts[pts.length - 1].v;
}

function weightedMean(points: { v: number; w: number }[]): number {
  const w = points.reduce((a, p) => a + p.w, 0);
  return w > 0 ? points.reduce((a, p) => a + p.v * p.w, 0) / w : 0;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const signedPct = (x: number) => `${x > 0 ? "+" : ""}${x}%`;

/** Same-weekday history samples of a fridge (days it sold on), with recency weights. */
function sameWeekdayDays(ctx: EngineContext, f: number): { d: number; w: number }[] {
  const wd = weekdayOf(ctx.today);
  const out: { d: number; w: number }[] = [];
  for (let d = 0; d < ctx.D; d++) {
    if (!ctx.sample[f * ctx.D + d]) continue;
    const day = histDay(ctx, d);
    if (weekdayOf(day) !== wd) continue;
    const w = recencyWeight(ctx.today - day);
    if (w > 0) out.push({ d, w });
  }
  return out;
}

/** Units sold at the fridge on history day d before minute m (all categories, partial current hour). */
function salesBefore(ctx: EngineContext, f: number, d: number, m: number): number {
  const h = Math.floor(m / 60);
  const frac = (m % 60) / 60;
  let s = 0;
  for (let c = 0; c < ctx.C; c++) {
    const base = ((f * ctx.C + c) * ctx.D + d) * 24;
    for (let k = 0; k < h; k++) s += ctx.snap.history.hourly[base + k];
    if (h < 24) s += ctx.snap.history.hourly[base + h] * frac;
  }
  return s;
}

/** Network share of every product over the last 90 days (recency weighted) and the same per fridge. */
function productShares(ctx: EngineContext) {
  const { F, P, D, snap } = ctx;
  const per = new Float64Array(F * P);
  const net = new Float64Array(P);
  const fTot = new Float64Array(F);
  let nTot = 0;
  for (let d = Math.max(0, D - 90); d < D; d++) {
    const w = recencyWeight(ctx.today - histDay(ctx, d));
    for (let f = 0; f < F; f++)
      for (let p = 0; p < P; p++) {
        const v = snap.history.productDaily[(f * P + p) * D + d] * w;
        if (!v) continue;
        per[f * P + p] += v;
        net[p] += v;
        fTot[f] += v;
        nTot += v;
      }
  }
  return { per, net, fTot, nTot };
}

export interface ProfileOptions {
  /** the one demand source, both horizons (AnalysisResult.demand) */
  demand: Record<Horizon, DemandCell[][]>;
}

export function buildProfiles(ctx: EngineContext, forecasts: FridgeForecast[], di: DemandIndexRow[], opts: ProfileOptions): FridgeProfile[] {
  const { snap } = ctx;
  const nowMin = ctx.nowMinute;
  const shares = productShares(ctx);

  return forecasts.map((ff, f) => {
    // ── data volume & confidence ──
    let dataDays = 0;
    for (let d = 0; d < ctx.D; d++) if (ctx.sample[f * ctx.D + d]) dataDays++;
    const same = sameWeekdayDays(ctx, f);
    // full confidence: ~4 months of history and ≥ 12 same weekdays; little data → about 50 %
    const confidence = Math.max(0.3, Math.min(0.98, 0.3 + 0.35 * Math.min(1, dataDays / 120) + 0.35 * Math.min(1, same.length / ENGINE_CONFIG.history.fullConfidenceSamples)));

    // ── the individual norm: same weekday, recency weighted, 25–75 % band ──
    const dayPts = same.map(({ d, w }) => ({ v: ctx.fridgeDay[f * ctx.D + d], w }));
    const nowPts = same.map(({ d, w }) => ({ v: salesBefore(ctx, f, d, nowMin), w }));
    const normalDay: Range = { low: Math.round(weightedQuantile(dayPts, 0.25)), high: Math.round(weightedQuantile(dayPts, 0.75)), avg: Math.round(weightedMean(dayPts)) };
    const normalByNow: Range = { low: Math.round(weightedQuantile(nowPts, 0.25)), high: Math.round(weightedQuantile(nowPts, 0.75)), avg: r1(weightedMean(nowPts)) };

    // ── today vs its own norm ──
    const sales = ff.salesToday;
    let status: DayStatus;
    let deviationPct: number | null = null;
    if (same.length < 3) status = "NO_DATA";
    else if (normalByNow.avg < 2 && sales < 3) status = "QUIET";
    else {
      deviationPct = normalByNow.avg > 0 ? Math.round((sales / normalByNow.avg - 1) * 100) : null;
      const ratio = normalByNow.avg > 0 ? sales / normalByNow.avg : Infinity;
      if (normalByNow.avg >= ENGINE_CONFIG.anomaly.minExpectedSoFar && (ratio >= 2 || ratio <= 0.4)) status = "ANOMALY";
      else if (sales > normalByNow.high) status = "ABOVE";
      else if (sales < normalByNow.low) status = "BELOW";
      else status = "NORMAL";
    }
    const at = fmtHM(nowMin);
    const typical = normalByNow.low === normalByNow.high ? `${normalByNow.low}` : `${normalByNow.low}–${normalByNow.high}`;
    const label =
      status === "NO_DATA"
        ? "мало истории для нормы"
        : status === "QUIET"
          ? `к ${at} обычно продаж почти нет`
          : `к ${at}: ${sales}, обычно по ${DAY_DATIVE[weekdayOf(ctx.today) - 1]} ${typical}`;

    // ── weekday profile (90 days), index 1.00 = average of selling weekdays ──
    const wdSum = new Array<number>(7).fill(0);
    const wdN = new Array<number>(7).fill(0);
    const fr = snap.fridges[f];
    for (let d = 0; d < ctx.D; d++) {
      const day = histDay(ctx, d);
      if (ctx.today - day > 90 || day < fr.activeSinceDay) continue;
      const wd = weekdayOf(day) - 1;
      wdSum[wd] += ctx.fridgeDay[f * ctx.D + d];
      wdN[wd]++;
    }
    const wdAvg = wdSum.map((s, i) => (wdN[i] ? s / wdN[i] : 0));
    const selling = wdAvg.filter((v) => v > 0.5);
    const mean = selling.length ? selling.reduce((a, b) => a + b, 0) / selling.length : 0;
    const weekdayIndex = wdAvg.map((v) => (mean > 0 ? Math.round((v / mean) * 100) / 100 : 0));
    // at most two strongest / weakest days (weak weekends must not turn every weekday into a "strong" one)
    const strongWeekdays = weekdayIndex.map((v, i) => ({ v, i })).filter((x) => x.v >= 1.12).sort((a, b) => b.v - a.v).slice(0, 2).map((x) => x.i);
    const weakWeekdays = weekdayIndex.map((v, i) => ({ v, i })).filter((x) => x.v > 0 && x.v <= 0.85).sort((a, b) => a.v - b.v).slice(0, 2).map((x) => x.i);

    // ── hours (activity profile, 00–23, crosses midnight) ──
    const act = activityProfile(ctx, f);
    const hTot = act.hourly.reduce((a, b) => a + b, 0) || 1;
    const sumH = (a: number, b: number) => act.hourly.slice(a, b).reduce((x, y) => x + y, 0);
    const morningShare = sumH(5, 11) / hTot;
    const eveningShare = (sumH(17, 24) + sumH(0, 5)) / hTot;

    // ── categories: affinity + stock context ──
    const categories: CategoryProfile[] = ff.categories.map((cf, c) => {
      const cat = snap.categories[c];
      const index = di[f]?.index[c] ?? 1;
      const now = opts.demand.NOW[f][c];
      const eve = opts.demand.UNTIL_EVENING[f][c];
      const status: StockStatus = now.need > 0 ? "LOW" : now.surplus > 0 ? "SURPLUS" : "OK";
      return {
        id: cat.id,
        name: cat.name,
        emoji: cat.emoji,
        index: Math.round(index * 100) / 100,
        vsNetworkPct: Math.round((index - 1) * 100),
        demand: index >= 1.15 ? "HIGH" : index <= 0.85 ? "LOW" : "NORMAL",
        stock: cf.stock,
        expectedNow: now.expected,
        untilEvening: eve.expected,
        projectedEvening: eve.projected,
        status,
        need: now.need,
        canGive: now.surplus,
        reason: now.reason,
      };
    });

    // ── dishes it loves (last 90 days, smoothed toward the network) ──
    const P = ctx.P;
    const fTot = shares.fTot[f];
    const prior = 5;
    const topProducts: ProductAffinity[] = [];
    for (let p = 0; p < P; p++) {
      const own = shares.per[f * P + p];
      if (own <= 0 || shares.nTot <= 0) continue;
      const netShare = shares.net[p] / shares.nTot;
      const ownShare = (own + prior * netShare) / (fTot + prior);
      let days = 0;
      let units = 0;
      for (let d = Math.max(0, ctx.D - 30); d < ctx.D; d++) {
        if (!ctx.sample[f * ctx.D + d]) continue;
        days++;
        units += snap.history.productDaily[(f * P + p) * ctx.D + d];
      }
      topProducts.push({ productIndex: p, perDay: days ? r1(units / days) : 0, affinity: netShare > 0 ? Math.round((ownShare / netShare) * 100) / 100 : 1 });
    }
    topProducts.sort((a, b) => b.perDay - a.perDay || b.affinity - a.affinity);

    // ── personality tags, computed from history only ──
    const tags: { emoji: string; label: string }[] = [];
    if (dataDays < 30) tags.push({ emoji: "🆕", label: "НОВАЯ ТОЧКА" });
    for (const cp of [...categories].sort((a, b) => b.index - a.index)) {
      if (cp.index >= 1.25) tags.push({ emoji: cp.emoji, label: TAG_HIGH[cp.id] });
    }
    for (const cp of [...categories].sort((a, b) => a.index - b.index)) {
      if (cp.index > 0 && cp.index <= 0.75) tags.push({ emoji: cp.emoji, label: TAG_LOW[cp.id] });
    }
    if (act.nightShare >= 0.12) tags.push({ emoji: "🌙", label: "НОЧНЫЕ ПРОДАЖИ" });
    else if (eveningShare >= 0.3) tags.push({ emoji: "🌆", label: "АКТИВНА ВЕЧЕРОМ" });
    if (morningShare >= 0.32) tags.push({ emoji: "🌅", label: "АКТИВНА УТРОМ" });
    if (strongWeekdays.length) tags.push({ emoji: "📈", label: `СИЛЬНЫЙ ДЕНЬ: ${DAY_SHORT[strongWeekdays[0]].toUpperCase()}` });
    if (weekdayIndex[5] === 0 && weekdayIndex[6] === 0) tags.push({ emoji: "🚫", label: "ВЫХОДНЫЕ БЕЗ ПРОДАЖ" });
    else if (act.weekendShare >= 0.25) tags.push({ emoji: "🗓", label: "ПРОДАЁТ В ВЫХОДНЫЕ" });

    // ── conclusions ──
    const summary: string[] = [];
    if (status === "ABOVE" || status === "BELOW" || status === "ANOMALY")
      summary.push(`Сегодня ${status === "BELOW" ? "ниже" : "выше"} нормы: ${signedPct(deviationPct ?? 0)}${status === "ANOMALY" ? " — аномалия, в норму не записывается" : ""}`);
    else if (status === "NORMAL") summary.push(`Сегодня в норме (${signedPct(deviationPct ?? 0)})`);
    for (const cp of categories) {
      if (cp.need > 0) summary.push(`Нужно: ${cp.emoji} ${cp.name} +${cp.need} (${cp.reason})`);
    }
    for (const cp of categories) {
      if (cp.canGive > 0) summary.push(`Может отдать: ${cp.emoji} ${cp.name} ×${cp.canGive} (${cp.reason})`);
    }

    return {
      fridgeIndex: f,
      dataDays,
      confidence: Math.round(confidence * 100) / 100,
      normalDay,
      normalByNow,
      today: { sales, deviationPct, status, label },
      peaks: act.peaks,
      weekdayIndex,
      strongWeekdays,
      weakWeekdays,
      nightShare: Math.round(act.nightShare * 100) / 100,
      eveningShare: Math.round(eveningShare * 100) / 100,
      morningShare: Math.round(morningShare * 100) / 100,
      categories,
      topProducts: topProducts.slice(0, 5),
      tags,
      summary,
    };
  });
}

/** Where a dish sells best inside a group: affinity per fridge (1.00 = network average). */
export function productAffinityByFridge(ctx: EngineContext, fridgeIdx: number[], limit = 10) {
  const shares = productShares(ctx);
  const P = ctx.P;
  const groupUnits = new Array<number>(P).fill(0);
  for (const f of fridgeIdx) for (let p = 0; p < P; p++) groupUnits[p] += shares.per[f * P + p];
  const top = groupUnits.map((u, p) => ({ u, p })).filter((x) => x.u > 0).sort((a, b) => b.u - a.u).slice(0, limit);
  return top.map(({ p }) => {
    const netShare = shares.nTot > 0 ? shares.net[p] / shares.nTot : 0;
    const per = fridgeIdx.map((f) => {
      const fTot = shares.fTot[f];
      const share = fTot > 0 ? (shares.per[f * P + p] + 5 * netShare) / (fTot + 5) : netShare;
      return netShare > 0 ? Math.round((share / netShare) * 100) / 100 : 1;
    });
    let best = 0;
    per.forEach((v, i) => {
      if (v > per[best]) best = i;
    });
    return { productIndex: p, affinity: per, best: fridgeIdx[best] };
  });
}
