import { histDay, type EngineContext } from "./history";
import { analyseBatches, type Batch, type BatchResult } from "./batches";
import { shelfHoursFor, type ShelfLifeSettings } from "../config/shelfLife";

/**
 * PRODUCT × FRIDGE — the question of the business:
 *   «Когда мы ставим это блюдо в этот холодильник, сколько штук поставить, чтобы за срок годности (48 / 72 ч)
 *    почти всё продалось и было минимум списаний?»
 *
 * Built on DELIVERIES (engine/batches.ts), never on "sales per calendar day": days when the dish was not in the menu
 * simply have no delivery and do not count.
 *  1. Every delivery: loaded → sold within the shelf life (FIFO: the oldest units go first) → unloaded / written off /
 *     left when the shelf life ended. Sell-through = sold within shelf life ÷ loaded.
 *  2. The norm from the last 8 COMPLETE deliveries (shelf life over, no data gap):
 *       ставить = how many usually sold within the shelf life (median), range = weak … usual loading;
 *       the last 3 deliveries all sold out → +1 (the demand was higher than what was there). Deliveries that keep leaving
 *       2+ for write-off are cut by construction (ставить = sold, not loaded) and named in "почему".
 *  3. Today's delivery = target − what is still fresh in the fridge (expired units do not count).
 *
 * Two steps: the HEAVY one (180 days of deliveries → StoredStat) runs in the nightly analytics job
 * (kitshop-data/analytics.ts) and is saved in PostgreSQL; productStats() only adds today's live facts (stock, its age,
 * the delivery still selling) — no 180-day work during the day.
 */

export const NORM = {
  /** complete deliveries used for the norm */
  recentBatches: 8,
  /** fewer complete deliveries → no norm */
  minBatches: 3,
  /** +1 when this many last deliveries sold out */
  soldOutRun: 3,
  /** "постоянно остаётся 2+ и списывается" (shown in "почему") */
  leftoverUnits: 2,
  leftoverShare: 0.6,
  minHistoryDays: 14,
  newDays: 21,
} as const;

export type ProductStatus = "NORMAL" | "MORE" | "TOO_MUCH" | "LESS" | "RARE" | "NO_DATA" | "UNUSED";
export type Confidence = "LOW" | "MEDIUM" | "HIGH";
export type DataQuality = "GOOD" | "INCOMPLETE" | "BAD";

export const STATUS_TEXT: Record<ProductStatus, string> = {
  NORMAL: "НОРМА",
  MORE: "СТАВИТЬ БОЛЬШЕ",
  TOO_MUCH: "СЛИШКОМ МНОГО",
  LESS: "СТАВИТЬ МЕНЬШЕ",
  RARE: "РЕДКИЙ СПРОС",
  NO_DATA: "НЕДОСТАТОЧНО ДАННЫХ",
  UNUSED: "НЕ ИСПОЛЬЗУЕТСЯ",
};
export const QUALITY_TEXT: Record<DataQuality, string> = { GOOD: "ХОРОШИЕ", INCOMPLETE: "НЕПОЛНЫЕ", BAD: "ДАННЫЕ НЕПОЛНЫЕ ❌" };
export const CONFIDENCE_TEXT: Record<Confidence, string> = { HIGH: "ВЫСОКАЯ", MEDIUM: "СРЕДНЯЯ", LOW: "НИЗКАЯ" };

type Range = { low: number; high: number };

export interface BatchSummary {
  count: number;
  open: number;
  loaded: number;
  sold: number;
  unloaded: number;
  writtenOff: number;
  left: number;
  /** 0..1, null = no complete delivery */
  sellThrough: number | null;
  usualLoaded: Range | null;
  usualSold: Range | null;
  usualLeft: Range | null;
  since: number | null;
}

/** The nightly (heavy) part of a dish in a fridge — saved in PostgreSQL (product_shop_stats). */
export interface StoredStat {
  sold: { d7: number; d14: number; d30: number; d60: number; d90: number; d180: number };
  soldPrev30: number;
  historyDays: number;
  firstDay: number | null;
  openDays30: number;
  salesDays30: number;
  loaded30: number;
  removed30: number;
  writtenOff30: number;
  shelfHours: number;
  shelfSource: "product" | "category";
  batches: BatchSummary;
  /** the last deliveries at the time of the job, newest first */
  recent: Batch[];
  /** complete deliveries used for the norm */
  recentComplete: number;
  /** usual size of a delivery (median of the recent complete ones) */
  loadedMedian: number | null;
  movementConsistent: boolean;
  norm: { min: number; rec: number; max: number } | null;
  recommendation: string;
  why: string[];
  status: ProductStatus;
  statusReason: string;
  /** reasons the data are incomplete (data quality) */
  incomplete: string[];
  isNew: boolean;
  sales30VsPrevPct: number | null;
  /** the job's day (results are "as of" that night) */
  asOfDay: number;
}

export interface ProductStat extends Omit<StoredStat, "incomplete" | "soldPrev30" | "recentComplete" | "loadedMedian" | "asOfDay"> {
  f: number;
  p: number;
  soldToday: number;
  stock: number;
  /** units in the fridge now by age (hours), expired ones apart — live */
  ages: { from: number; to: number; qty: number }[];
  expiredNow: number;
  /** the delivery still selling (TODAY): put / sold so far — live */
  current: { at: number; loaded: number; soldSoFar: number } | null;
  /** today's delivery: the target, what is still fresh, how many to bring */
  plan: { target: number; fresh: number; delivery: number } | null;
  quality: DataQuality;
  qualityReason: string;
  confidence: Confidence;
  confidenceReason: string;
  demand: "HIGH" | "NORMAL" | "LOW" | null;
  analysisDay: number | null;
}

export interface ProductStats {
  at: (ProductStat | undefined)[];
  byFridge: ProductStat[][];
}

const units = (n: number) => `${n} шт.`;
const rng = (r: Range) => (r.low === r.high ? units(r.low) : `${r.low}–${r.high} шт.`);
const ddmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** Nearest-rank quantile of whole numbers (always one of the values). */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

const usual = (xs: number[]): Range | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return { low: quantile(s, 0.25), high: quantile(s, 0.75) };
};

const roundBatch = (b: Batch): Batch => ({
  ...b,
  loaded: Math.round(b.loaded),
  before: Math.round(b.before),
  sold24: Math.round(b.sold24),
  soldInShelf: Math.round(b.soldInShelf),
  soldAfter: Math.round(b.soldAfter),
  unloaded: Math.round(b.unloaded),
  writtenOff: Math.round(b.writtenOff),
  leftAtExpiry: b.leftAtExpiry === null ? null : Math.round(b.leftAtExpiry),
});

/**
 * HEAVY step (nightly): the deliveries of one dish in one fridge → the norm.
 * `daily` are the facts per history day (index 0 = the oldest day); `br` the delivery replay over the whole history.
 */
export function storedStatFor(input: {
  today: number;
  startDay: number;
  historyFromDay: number;
  /** day numbers of the fridge's open days (any receipt) */
  openDay: (day: number) => boolean;
  soldDaily: ArrayLike<number>;
  loadedDaily: ArrayLike<number>;
  removedDaily: ArrayLike<number>;
  writtenOffDaily: ArrayLike<number>;
  firstDay: number | null;
  shelf: { hours: number; source: "product" | "category" };
  br: BatchResult;
  fillupsKnown: boolean;
  gapDays: number;
}): StoredStat {
  const { today, startDay } = input;
  const D = input.soldDaily.length;
  const sold = { d7: 0, d14: 0, d30: 0, d60: 0, d90: 0, d180: 0 };
  let soldPrev30 = 0;
  let openDays30 = 0;
  let salesDays30 = 0;
  let loaded30 = 0;
  let removed30 = 0;
  let writtenOff30 = 0;
  const first = input.firstDay;
  for (let d = 0; d < D; d++) {
    const day = startDay + d;
    const age = today - day;
    if (age < 1 || age > 180) continue;
    const q = Math.round(input.soldDaily[d]);
    if (age <= 7) sold.d7 += q;
    if (age <= 14) sold.d14 += q;
    if (age <= 30) sold.d30 += q;
    if (age <= 60) sold.d60 += q;
    if (age <= 90) sold.d90 += q;
    sold.d180 += q;
    if (age > 30 && age <= 60) soldPrev30 += q;
    if (age <= 30) {
      loaded30 += input.loadedDaily[d];
      removed30 += input.removedDaily[d];
      writtenOff30 += input.writtenOffDaily[d];
      if (input.openDay(day) && first !== null && day >= first) {
        openDays30++;
        if (q > 0) salesDays30++;
      }
    }
  }
  loaded30 = Math.round(loaded30);
  removed30 = Math.round(removed30);
  writtenOff30 = Math.round(writtenOff30);
  const historyStart = input.historyFromDay;
  const historyDays = first === null ? 0 : Math.max(0, today - Math.max(first, historyStart));
  const isNew = first !== null && first >= historyStart + NORM.minHistoryDays && today - first <= NORM.newDays;
  const shelf = input.shelf;
  const br = input.br;

  const complete = br.batches.filter((b) => b.complete);
  const recentComplete = complete.slice(-NORM.recentBatches);
  const sumB = (k: (b: Batch) => number) => complete.reduce((a, b) => a + k(b), 0);
  const totalLoaded = Math.round(sumB((b) => b.loaded));
  const totalSold = Math.round(sumB((b) => b.soldInShelf));
  const batches: BatchSummary = {
    count: complete.length,
    open: br.batches.length - complete.length,
    loaded: totalLoaded,
    sold: totalSold,
    unloaded: Math.round(sumB((b) => b.unloaded)),
    writtenOff: Math.round(sumB((b) => b.writtenOff)),
    left: Math.round(sumB((b) => b.leftAtExpiry ?? 0)),
    sellThrough: totalLoaded > 0 ? totalSold / totalLoaded : null,
    usualLoaded: usual(recentComplete.map((b) => Math.round(b.loaded))),
    usualSold: usual(recentComplete.map((b) => Math.round(b.soldInShelf))),
    usualLeft: usual(recentComplete.map((b) => Math.round(b.leftAtExpiry ?? 0))),
    since: complete.length ? complete[0].at : null,
  };

  const why: string[] = [];
  let norm: StoredStat["norm"] = null;
  let status: ProductStatus = "NORMAL";
  let statusReason = "количество подходит";
  let recommendation = "";
  let loadedMedian: number | null = null;

  if (recentComplete.length < NORM.minBatches) {
    status = "NO_DATA";
    statusReason = `завершённых поставок ${recentComplete.length} (нужно хотя бы ${NORM.minBatches})`;
    recommendation = "Недостаточно данных: мало поставок";
    if (br.batches.length) {
      const last = br.batches[br.batches.length - 1];
      why.push(`последняя поставка ${ddmm(last.at)}: поставили ${units(Math.round(last.loaded))}, продано ${units(Math.round(last.soldInShelf))}`);
    }
  } else {
    const soldS = recentComplete.map((b) => Math.round(b.soldInShelf)).sort((a, b) => a - b);
    const loadedS = recentComplete.map((b) => Math.round(b.loaded)).sort((a, b) => a - b);
    loadedMedian = quantile(loadedS, 0.5);
    let rec = quantile(soldS, 0.5);
    why.push(`за срок годности ${shelf.hours} ч: ${recentComplete.length} последних поставок — обычно ставили ${rng(batches.usualLoaded!)}, продавалось ${rng(batches.usualSold!)}, оставалось ${rng(batches.usualLeft!)}`);
    if (rec === 0) {
      norm = { min: 0, rec: 0, max: 1 };
      status = "RARE";
      statusReason = "за срок годности почти ничего не продаётся";
      recommendation = "Не держать ежедневно — почти не продаётся";
    } else {
      let low = Math.max(1, quantile(soldS, 0.25));
      let high = Math.max(rec, Math.min(loadedMedian, quantile(soldS, 0.75) + 1));
      const lastRun = recentComplete.slice(-NORM.soldOutRun);
      if (lastRun.length === NORM.soldOutRun && lastRun.every((b) => b.soldOut)) {
        rec += 1;
        high = Math.max(high, rec);
        why.push(`последние ${NORM.soldOutRun} поставки ушли полностью — +1 шт. (проверить ${units(rec)})`);
      } else {
        // "ставить" is what sold, not what was loaded: deliveries that kept leaving 2+ for write-off are already cut
        const wasteful = recentComplete.filter((b) => (b.leftAtExpiry ?? 0) >= NORM.leftoverUnits && b.writtenOff > 0);
        if (wasteful.length >= NORM.leftoverShare * recentComplete.length)
          why.push(`в ${wasteful.length} из ${recentComplete.length} поставок оставалось 2+ и списывалось — ставить меньше, чем ставили (${units(loadedMedian)} → ${units(rec)})`);
      }
      low = Math.min(low, rec);
      norm = { min: low, rec, max: high };
      recommendation = `Ставить ${units(rec)}`;
      if (rec > loadedMedian) {
        status = "MORE";
        statusReason = `обычно ставили ${units(loadedMedian)}, нужно ${units(rec)}`;
      } else if (rec < loadedMedian) {
        status = "LESS";
        statusReason = `обычно ставили ${units(loadedMedian)}, продаётся ${units(rec)}`;
      }
    }
    if (batches.sellThrough !== null) why.push(`реализация с ${ddmm(batches.since!)}: продано ${totalSold} из ${totalLoaded} (${Math.round(batches.sellThrough * 100)}%), снято ${units(batches.unloaded)}, списано ${units(batches.writtenOff)}`);
  }
  if (!br.consistent) why.push("движение товара в KiT Shop не сходится с остатком — начальный остаток неизвестен");

  const incomplete: string[] = [];
  if (!input.fillupsKnown) incomplete.push("загрузки/снятия за 30 дней неполные");
  if (!br.consistent) incomplete.push("движение не сходится с остатком");
  if (input.gapDays) incomplete.push(`в истории дыры (${input.gapDays} дн.)`);
  if (recentComplete.length < 6) incomplete.push(recentComplete.length ? `всего ${recentComplete.length} завершённых поставок` : "поставок (загрузок KiT Shop) нет");

  return {
    sold,
    soldPrev30,
    historyDays,
    firstDay: first,
    openDays30,
    salesDays30,
    loaded30,
    removed30,
    writtenOff30,
    shelfHours: shelf.hours,
    shelfSource: shelf.source,
    batches,
    recent: [...br.batches].slice(-NORM.recentBatches).reverse().map(roundBatch),
    recentComplete: recentComplete.length,
    loadedMedian,
    movementConsistent: br.consistent,
    norm,
    recommendation,
    why,
    status,
    statusReason,
    incomplete,
    isNew,
    sales30VsPrevPct: historyDays >= 60 && soldPrev30 > 0 ? Math.round((sold.d30 / soldPrev30 - 1) * 100) : null,
    asOfDay: today,
  };
}

/** A dish the nightly job has not seen yet (new since last night). */
export function emptyStored(today: number, shelf: { hours: number; source: "product" | "category" }, reason: string): StoredStat {
  return {
    sold: { d7: 0, d14: 0, d30: 0, d60: 0, d90: 0, d180: 0 },
    soldPrev30: 0,
    historyDays: 0,
    firstDay: today,
    openDays30: 0,
    salesDays30: 0,
    loaded30: 0,
    removed30: 0,
    writtenOff30: 0,
    shelfHours: shelf.hours,
    shelfSource: shelf.source,
    batches: { count: 0, open: 0, loaded: 0, sold: 0, unloaded: 0, writtenOff: 0, left: 0, sellThrough: null, usualLoaded: null, usualSold: null, usualLeft: null, since: null },
    recent: [],
    recentComplete: 0,
    loadedMedian: null,
    movementConsistent: true,
    norm: null,
    recommendation: "Недостаточно данных",
    why: [reason],
    status: "NO_DATA",
    statusReason: reason,
    incomplete: [reason],
    isNew: true,
    sales30VsPrevPct: null,
    asOfDay: today,
  };
}

const cache = new WeakMap<EngineContext, ProductStats>();

/**
 * LIGHT step (every analysis): the stored nightly result + today's live facts — stock, its age, the delivery still
 * selling, data checks. Simulator snapshots (no KiT Shop movements) get a clearly marked day-based fallback.
 */
export function productStats(ctx: EngineContext, shelfLife?: ShelfLifeSettings): ProductStats {
  const hit = cache.get(ctx);
  if (hit) return hit;
  const { F, P, D, snap } = ctx;
  const pd = snap.productDays;
  const daily = snap.history.productDaily;
  const today = ctx.today;
  const now = snap.now;

  const at: (ProductStat | undefined)[] = new Array(F * P);
  const byFridge: ProductStat[][] = snap.fridges.map(() => []);

  for (let f = 0; f < F; f++) {
    const checks = pd?.checks[f] ?? [];
    const failed = checks.filter((c) => c.level === "FAIL");
    for (let p = 0; p < P; p++) {
      const stock = snap.stock[f * P + p];
      const soldToday = Math.round(snap.today.productSales[f * P + p]);
      const pr = snap.products[p];
      const shelf = shelfHoursFor(shelfLife, pr.id, pr.categoryId);
      let stored: StoredStat | undefined = pd?.stats[f * P + p];
      if (!pd) stored = simulatorStat(ctx, f, p, shelf);
      if (!stored) {
        if (stock <= 0 && soldToday <= 0) continue;
        stored = emptyStored(today, shelf, "новое блюдо в этой точке: ночной расчёт его ещё не видел");
      }

      // today's live facts: the last days' movements replayed (the stock's age, the delivery still selling)
      const live = pd
        ? analyseBatches({ events: pd.recent[f * P + p], from: pd.recentFrom, now, currentStock: stock, shelfHours: stored.shelfHours })
        : null;
      const expiredNow = Math.round(live?.expiredNow ?? 0);
      const fresh = Math.max(0, stock - expiredNow);
      const lastLive = live?.batches[live.batches.length - 1];
      const current = lastLive && lastLive.at + stored.shelfHours * 3_600_000 > now ? { at: lastLive.at, loaded: Math.round(lastLive.loaded), soldSoFar: Math.round(lastLive.soldInShelf + lastLive.soldAfter) } : null;

      let { norm, status, statusReason, recommendation } = stored;
      const why = [...stored.why];
      if (expiredNow > 0) why.push(`в холодильнике ${units(expiredNow)} старше ${stored.shelfHours} ч — снять`);
      if (current) why.push(`текущая поставка ${ddmm(current.at)}: поставили ${units(current.loaded)}, уже продано ${units(current.soldSoFar)}`);
      if (stored.sold.d30 === 0 && stored.loaded30 === 0 && stock <= 0 && soldToday === 0) {
        status = "UNUSED";
        statusReason = "30 дней нет ни продаж, ни загрузок";
        recommendation = "Не используется";
        norm = null;
      } else if (norm && norm.rec > 0 && fresh >= norm.max + 2) {
        status = "TOO_MUCH";
        statusReason = `сейчас годных ${units(fresh)}, а за срок обычно уходит до ${units(norm.max)}`;
      }
      // a failed data check: nothing to trust
      if (failed.length && status !== "UNUSED") {
        norm = null;
        status = "NO_DATA";
        statusReason = `проверка данных не пройдена: ${failed.map((c) => c.label.toLowerCase()).join(", ")}`;
        recommendation = "ДАННЫЕ НЕПОЛНЫЕ — нормы нет, пока не пройдена проверка данных";
      }
      const incomplete = status === "UNUSED" ? stored.incomplete.filter((x) => !x.startsWith("поставок")) : stored.incomplete;
      const quality: DataQuality = failed.length ? "BAD" : incomplete.length ? "INCOMPLETE" : "GOOD";
      const qualityReason = failed.length ? `проверка не пройдена: ${failed.map((c) => c.label.toLowerCase()).join(", ")}` : incomplete.length ? incomplete.join("; ") : "продажи, загрузки, снятия и списания полные";
      const confidence: Confidence = quality === "GOOD" && stored.recentComplete >= 6 ? "HIGH" : quality !== "BAD" && stored.recentComplete >= NORM.minBatches ? "MEDIUM" : "LOW";
      const confidenceReason = quality === "BAD" ? qualityReason : stored.recentComplete < NORM.minBatches ? `завершённых поставок ${stored.recentComplete}` : incomplete[0] ?? `${stored.recentComplete} полных поставок`;

      const { incomplete: _i, soldPrev30: _s, recentComplete: _r, loadedMedian: _l, asOfDay, ...base } = stored;
      void _i;
      void _s;
      void _r;
      void _l;
      const st: ProductStat = {
        ...base,
        f,
        p,
        soldToday,
        stock,
        ages: (live?.ages ?? []).map((a) => ({ ...a, qty: Math.round(a.qty) })),
        expiredNow,
        current,
        plan: norm ? { target: norm.rec, fresh, delivery: Math.max(0, norm.rec - fresh) } : null,
        norm,
        recommendation,
        why,
        status,
        statusReason,
        quality,
        qualityReason,
        confidence,
        confidenceReason,
        demand: null,
        analysisDay: pd ? asOfDay : null,
      };
      at[f * P + p] = st;
      byFridge[f].push(st);
    }
  }
  void D;
  void daily;

  for (const rows of byFridge) {
    const ranked = rows.filter((x) => x.sold.d30 > 0 && x.status !== "NO_DATA").sort((a, b) => b.sold.d30 - a.sold.d30);
    const q = Math.max(1, Math.floor(ranked.length / 4));
    ranked.forEach((x, i) => (x.demand = ranked.length < 4 ? "NORMAL" : i < q ? "HIGH" : i >= ranked.length - q ? "LOW" : "NORMAL"));
  }

  const out = { at, byFridge };
  cache.set(ctx, out);
  return out;
}

/** SIMULATOR only (no KiT Shop movements exist): days with sales stand in for deliveries, clearly marked. */
function simulatorStat(ctx: EngineContext, f: number, p: number, shelf: { hours: number; source: "product" | "category" }): StoredStat | undefined {
  const { D, P, snap } = ctx;
  const base = (f * P + p) * D;
  const daily = snap.history.productDaily;
  const days: number[] = [];
  let first: number | null = null;
  for (let d = 0; d < D; d++) {
    const q = Math.round(daily[base + d]);
    if (q > 0 && first === null) first = histDay(ctx, d);
    const age = ctx.today - histDay(ctx, d);
    if (age >= 1 && age <= 30 && q > 0) days.push(q);
  }
  if (first === null && snap.stock[f * P + p] <= 0) return undefined;
  const zero = new Float32Array(D);
  const st = storedStatFor({
    today: ctx.today,
    startDay: snap.history.startDay,
    historyFromDay: snap.history.startDay,
    openDay: (day) => ctx.sample[f * D + (day - snap.history.startDay)] === 1,
    soldDaily: daily.subarray(base, base + D),
    loadedDaily: zero,
    removedDaily: zero,
    writtenOffDaily: zero,
    firstDay: first,
    shelf,
    br: { batches: [], ages: [], expiredNow: 0, startStock: 0, consistent: true, replayStock: 0, unattributed: 0, lots: [] },
    fillupsKnown: false,
    gapDays: 0,
  });
  days.sort((a, b) => a - b);
  if (days.length >= NORM.minBatches) {
    const rec = Math.max(1, quantile(days, 0.5));
    st.norm = { min: Math.min(rec, Math.max(1, quantile(days, 0.25))), rec, max: Math.max(rec, quantile(days, 0.75)) };
    st.status = "NORMAL";
    st.statusReason = "количество подходит";
    st.recommendation = `Ставить ${units(rec)} (симулятор)`;
    st.why = ["режим симулятора: поставок KiT Shop нет, дни с продажами вместо поставок"];
    st.recentComplete = NORM.minBatches;
  } else {
    st.statusReason = "мало данных (режим симулятора)";
    st.recommendation = "Недостаточно данных";
  }
  return st;
}
