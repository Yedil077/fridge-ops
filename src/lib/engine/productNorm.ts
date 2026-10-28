import { histDay, type EngineContext } from "./history";
import { analyseBatches, type Batch } from "./batches";
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
 * Whole units only. A failed data check → no norm at all ("ДАННЫЕ НЕПОЛНЫЕ").
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

export interface ProductStat {
  f: number;
  p: number;
  sold: { d7: number; d30: number; d60: number; d90: number; d180: number };
  soldToday: number;
  historyDays: number;
  firstDay: number | null;
  openDays30: number;
  salesDays30: number;
  loaded30: number;
  removed30: number;
  writtenOff30: number;
  stock: number;
  shelfHours: number;
  shelfSource: "product" | "category";
  /** all complete deliveries since the data are complete */
  batches: {
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
  };
  /** the last deliveries, newest first (complete and not yet) */
  recent: Batch[];
  /** units in the fridge now by age (hours), expired ones apart */
  ages: { from: number; to: number; qty: number }[];
  expiredNow: number;
  movementConsistent: boolean;
  /** today's delivery: the target, what is still fresh, how many to bring */
  plan: { target: number; fresh: number; delivery: number } | null;
  norm: { min: number; rec: number; max: number } | null;
  recommendation: string;
  why: string[];
  status: ProductStatus;
  statusReason: string;
  quality: DataQuality;
  qualityReason: string;
  confidence: Confidence;
  confidenceReason: string;
  isNew: boolean;
  demand: "HIGH" | "NORMAL" | "LOW" | null;
  sales30VsPrevPct: number | null;
}

export interface ProductStats {
  at: (ProductStat | undefined)[];
  byFridge: ProductStat[][];
}

const cache = new WeakMap<EngineContext, ProductStats>();
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

export function productStats(ctx: EngineContext, shelfLife?: ShelfLifeSettings): ProductStats {
  const hit = cache.get(ctx);
  if (hit) return hit;
  const { F, P, D, snap } = ctx;
  const pd = snap.productDays;
  const daily = snap.history.productDaily;
  const today = ctx.today;
  const now = snap.now;
  const historyStart = snap.historyFromDay ?? snap.history.startDay;

  const at: (ProductStat | undefined)[] = new Array(F * P);
  const byFridge: ProductStat[][] = snap.fridges.map(() => []);

  for (let f = 0; f < F; f++) {
    const checks = pd?.checks[f] ?? [];
    const failed = checks.filter((c) => c.level === "FAIL");
    const gapDays = new Set((pd?.continuity[f] ?? []).filter((d) => d.status === "GAP").map((d) => d.day));
    for (let p = 0; p < P; p++) {
      const base = (f * P + p) * D;
      const stock = snap.stock[f * P + p];
      const soldToday = Math.round(snap.today.productSales[f * P + p]);
      const pr = snap.products[p];
      let first = pd && pd.firstDay[f * P + p] >= 0 ? pd.firstDay[f * P + p] : -1;
      if (first < 0) for (let d = 0; d < D; d++) if (daily[base + d] > 0) { first = histDay(ctx, d); break; }
      if (first < 0 && soldToday > 0) first = today;
      if (first < 0 && stock <= 0) continue;

      // facts: sales by windows, loads / unloads / write-offs in 30 days
      const sold = { d7: 0, d30: 0, d60: 0, d90: 0, d180: 0 };
      let soldPrev30 = 0;
      let openDays30 = 0;
      let salesDays30 = 0;
      let loaded30 = 0;
      let removed30 = 0;
      let writtenOff30 = 0;
      for (let d = 0; d < D; d++) {
        const age = today - histDay(ctx, d);
        if (age < 1 || age > 180) continue;
        const q = Math.round(daily[base + d]);
        if (age <= 7) sold.d7 += q;
        if (age <= 30) sold.d30 += q;
        if (age <= 60) sold.d60 += q;
        if (age <= 90) sold.d90 += q;
        sold.d180 += q;
        if (age > 30 && age <= 60) soldPrev30 += q;
        if (age <= 30) {
          if (pd) {
            loaded30 += pd.loaded[base + d];
            removed30 += pd.removed[base + d];
            writtenOff30 += pd.writtenOff[base + d];
          }
          if (ctx.sample[f * D + d] && histDay(ctx, d) >= first) {
            openDays30++;
            if (q > 0) salesDays30++;
          }
        }
      }
      loaded30 = Math.round(loaded30);
      removed30 = Math.round(removed30);
      writtenOff30 = Math.round(writtenOff30);
      const historyDays = Math.max(0, today - Math.max(first, historyStart));
      const isNew = first >= historyStart + NORM.minHistoryDays && today - first <= NORM.newDays;
      const shelf = shelfHoursFor(shelfLife, pr.id, pr.categoryId);

      // ── deliveries
      const br = pd
        ? analyseBatches({ events: pd.events[f * P + p], from: pd.eventsFrom, now, currentStock: stock, shelfHours: shelf.hours, gapDays })
        : { batches: [], ages: [], expiredNow: 0, startStock: 0, consistent: true, replayStock: stock, unattributed: 0 };
      const complete = br.batches.filter((b) => b.complete);
      const recentComplete = complete.slice(-NORM.recentBatches);
      const sumB = (k: (b: Batch) => number) => complete.reduce((a, b) => a + k(b), 0);
      const totalLoaded = Math.round(sumB((b) => b.loaded));
      const totalSold = Math.round(sumB((b) => b.soldInShelf));
      const batches: ProductStat["batches"] = {
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
      const fresh = Math.max(0, stock - br.expiredNow);

      const why: string[] = [];
      let norm: ProductStat["norm"] = null;
      let status: ProductStatus = "NORMAL";
      let statusReason = "количество подходит";
      let recommendation = "";

      if (sold.d30 === 0 && loaded30 === 0 && stock <= 0 && soldToday === 0) {
        status = "UNUSED";
        statusReason = "30 дней нет ни продаж, ни загрузок";
        recommendation = "Не используется";
      } else if (!pd) {
        // SIMULATOR only (no KiT Shop movements exist): days with sales stand in for deliveries, clearly marked
        const days: number[] = [];
        for (let d = 0; d < D; d++) {
          const age = today - histDay(ctx, d);
          const q = Math.round(daily[base + d]);
          if (age >= 1 && age <= 30 && q > 0) days.push(q);
        }
        days.sort((a, b) => a - b);
        if (days.length >= NORM.minBatches) {
          const rec = Math.max(1, quantile(days, 0.5));
          norm = { min: Math.min(rec, Math.max(1, quantile(days, 0.25))), rec, max: Math.max(rec, quantile(days, 0.75)) };
          recommendation = `Ставить ${units(rec)} (симулятор)`;
          why.push("режим симулятора: поставок KiT Shop нет, дни с продажами вместо поставок");
        } else {
          status = "NO_DATA";
          statusReason = "мало данных (режим симулятора)";
          recommendation = "Недостаточно данных";
        }
      } else if (recentComplete.length < NORM.minBatches) {
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
        const loadedMed = quantile(loadedS, 0.5);
        let rec = quantile(soldS, 0.5);
        why.push(`за срок годности ${shelf.hours} ч: ${recentComplete.length} последних поставок — обычно ставили ${rng(batches.usualLoaded!)}, продавалось ${rng(batches.usualSold!)}, оставалось ${rng(batches.usualLeft!)}`);
        if (rec === 0) {
          norm = { min: 0, rec: 0, max: 1 };
          status = "RARE";
          statusReason = "за срок годности почти ничего не продаётся";
          recommendation = "Не держать ежедневно — почти не продаётся";
        } else {
          let low = Math.max(1, quantile(soldS, 0.25));
          let high = Math.max(rec, Math.min(loadedMed, quantile(soldS, 0.75) + 1));
          const lastRun = recentComplete.slice(-NORM.soldOutRun);
          if (lastRun.length === NORM.soldOutRun && lastRun.every((b) => b.soldOut)) {
            rec += 1;
            high = Math.max(high, rec);
            why.push(`последние ${NORM.soldOutRun} поставки ушли полностью — +1 шт.`);
          } else {
            // "ставить" is what sold, not what was loaded: deliveries that kept leaving 2+ for write-off are already cut
            const wasteful = recentComplete.filter((b) => (b.leftAtExpiry ?? 0) >= NORM.leftoverUnits && b.writtenOff > 0);
            if (wasteful.length >= NORM.leftoverShare * recentComplete.length)
              why.push(`в ${wasteful.length} из ${recentComplete.length} поставок оставалось 2+ и списывалось — ставить меньше, чем ставили (${units(loadedMed)} → ${units(rec)})`);
          }
          low = Math.min(low, rec);
          norm = { min: low, rec, max: high };
          recommendation = `Ставить ${units(rec)}`;
          if (rec > loadedMed) {
            status = "MORE";
            statusReason = `обычно ставили ${units(loadedMed)}, нужно ${units(rec)}`;
          } else if (rec < loadedMed) {
            status = "LESS";
            statusReason = `обычно ставили ${units(loadedMed)}, продаётся ${units(rec)}`;
          }
          if (fresh >= high + 2) {
            status = "TOO_MUCH";
            statusReason = `сейчас годных ${units(fresh)}, а за срок обычно уходит до ${units(high)}`;
          }
        }
        if (batches.sellThrough !== null) why.push(`реализация с ${ddmm(batches.since!)}: продано ${totalSold} из ${totalLoaded} (${Math.round(batches.sellThrough * 100)}%), снято ${units(batches.unloaded)}, списано ${units(batches.writtenOff)}`);
      }
      if (!br.consistent) why.push("движение товара в KiT Shop не сходится с остатком — начальный остаток неизвестен");
      if (br.expiredNow > 0) why.push(`в холодильнике ${units(br.expiredNow)} старше ${shelf.hours} ч — снять`);

      // a failed data check: nothing to trust
      if (failed.length && status !== "UNUSED") {
        norm = null;
        status = "NO_DATA";
        statusReason = `проверка данных не пройдена: ${failed.map((c) => c.label.toLowerCase()).join(", ")}`;
        recommendation = "ДАННЫЕ НЕПОЛНЫЕ — нормы нет, пока не пройдена проверка данных";
      }

      const fillupsKnown = pd ? pd.fillupsFromDay !== null && pd.fillupsFromDay <= today - 30 : false;
      const incomplete: string[] = [];
      if (!fillupsKnown) incomplete.push("загрузки/снятия за 30 дней неполные");
      if (!br.consistent) incomplete.push("движение не сходится с остатком");
      if (gapDays.size) incomplete.push(`в истории дыры (${gapDays.size} дн.)`);
      if (recentComplete.length < 6 && status !== "UNUSED") incomplete.push(recentComplete.length ? `всего ${recentComplete.length} завершённых поставок` : "поставок (загрузок KiT Shop) нет");
      const quality: DataQuality = failed.length ? "BAD" : incomplete.length ? "INCOMPLETE" : "GOOD";
      const qualityReason = failed.length ? `проверка не пройдена: ${failed.map((c) => c.label.toLowerCase()).join(", ")}` : incomplete.length ? incomplete.join("; ") : "продажи, загрузки, снятия и списания полные";
      const confidence: Confidence = quality === "GOOD" && recentComplete.length >= 6 ? "HIGH" : quality !== "BAD" && recentComplete.length >= NORM.minBatches ? "MEDIUM" : "LOW";
      const confidenceReason = quality === "BAD" ? qualityReason : recentComplete.length < NORM.minBatches ? `завершённых поставок ${recentComplete.length}` : incomplete[0] ?? `${recentComplete.length} полных поставок`;

      const st: ProductStat = {
        f,
        p,
        sold,
        soldToday,
        historyDays,
        firstDay: first,
        openDays30,
        salesDays30,
        loaded30,
        removed30,
        writtenOff30,
        stock,
        shelfHours: shelf.hours,
        shelfSource: shelf.source,
        batches,
        recent: [...br.batches].slice(-NORM.recentBatches).reverse().map((b) => ({
          ...b,
          loaded: Math.round(b.loaded),
          before: Math.round(b.before),
          sold24: Math.round(b.sold24),
          soldInShelf: Math.round(b.soldInShelf),
          soldAfter: Math.round(b.soldAfter),
          unloaded: Math.round(b.unloaded),
          writtenOff: Math.round(b.writtenOff),
          leftAtExpiry: b.leftAtExpiry === null ? null : Math.round(b.leftAtExpiry),
        })),
        ages: br.ages.map((a) => ({ ...a, qty: Math.round(a.qty) })),
        expiredNow: Math.round(br.expiredNow),
        movementConsistent: br.consistent,
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
        isNew,
        demand: null,
        sales30VsPrevPct: historyDays >= 60 && soldPrev30 > 0 ? Math.round((sold.d30 / soldPrev30 - 1) * 100) : null,
      };
      at[f * P + p] = st;
      byFridge[f].push(st);
    }
  }

  for (const rows of byFridge) {
    const ranked = rows.filter((x) => x.sold.d30 > 0 && x.status !== "NO_DATA").sort((a, b) => b.sold.d30 - a.sold.d30);
    const q = Math.max(1, Math.floor(ranked.length / 4));
    ranked.forEach((x, i) => (x.demand = ranked.length < 4 ? "NORMAL" : i < q ? "HIGH" : i >= ranked.length - q ? "LOW" : "NORMAL"));
  }

  const out = { at, byFridge };
  cache.set(ctx, out);
  return out;
}
