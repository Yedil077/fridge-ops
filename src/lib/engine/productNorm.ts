import { histDay, type EngineContext } from "./history";

/**
 * PRODUCT × FRIDGE: how many of THIS dish to put into THIS fridge per day — in WHOLE units, from facts.
 *
 * People buy whole dishes, so everything shown is a count of units; averages stay inside.
 *  1. Sample days (last 30 days, 60 if the dish sells rarely):
 *       • FACT — days when the 5-minute stock history shows the dish was there most of the selling time (zeros count:
 *         it was there and nobody bought it);
 *       • otherwise days WITH SALES (the dish surely was there; days without sales are not taken as "no demand",
 *         because without the stock history we do not know whether it was there) — the result is less certain.
 *     The reconstruction of past stock is an ESTIMATE: shown separately, never used for the norm.
 *  2. Units sold per sample day → "обычно" = 25–75 %, "в сильные дни" = 90 %.
 *  3. Norm = 75 % of the sample days (at least 1), minimum = 25 % (at least 1), maximum = 90 %.
 *  4. Losses (KiT Shop operations, facts): unloads + write-offs ≥ 30 % of what was loaded → norm = the usual day (median).
 *     Sold out on ≥ 25 % of the FACT days → norm + 1 (not above maximum + 1).
 *  5. Rare: bought on ≤ 30 % of open days → if the stock history confirms it stood there → "не держать ежедневно",
 *     otherwise 1 unit with low confidence.
 * Data quality and confidence come from the fridge's data checks and from how much real history there is.
 */

export const NORM = {
  windowDays: 30,
  rareWindowDays: 60,
  /** FACT days needed to use them as the sample */
  minFactDays: 7,
  /** fewer sample days → no norm ("не хватает данных") */
  minSampleDays: 5,
  minHistoryDays: 14,
  lossShare: 0.3,
  minLoaded: 5,
  soldOutShare: 0.25,
  rareShare: 0.3,
  newDays: 21,
} as const;

export type ProductStatus = "NORMAL" | "MORE" | "TOO_MUCH" | "LESS" | "RARE" | "NO_DATA" | "UNUSED";
export type Confidence = "LOW" | "MEDIUM" | "HIGH";
export type DataQuality = "GOOD" | "INCOMPLETE" | "BAD";

export const STATUS_TEXT: Record<ProductStatus, string> = {
  NORMAL: "НОРМА",
  MORE: "НУЖНО БОЛЬШЕ",
  TOO_MUCH: "СЛИШКОМ МНОГО",
  LESS: "СТАВИТЬ МЕНЬШЕ",
  RARE: "РЕДКИЙ СПРОС",
  NO_DATA: "НЕ ХВАТАЕТ ДАННЫХ",
  UNUSED: "НЕ ИСПОЛЬЗУЕТСЯ",
};
export const QUALITY_TEXT: Record<DataQuality, string> = { GOOD: "ХОРОШИЕ", INCOMPLETE: "НЕПОЛНЫЕ", BAD: "ПЛОХИЕ" };
export const CONFIDENCE_TEXT: Record<Confidence, string> = { HIGH: "ВЫСОКАЯ", MEDIUM: "СРЕДНЯЯ", LOW: "НИЗКАЯ" };

export interface ProductStat {
  f: number;
  p: number;
  /** units sold (whole) */
  sold: { d7: number; d30: number; d60: number; d90: number; d180: number };
  soldToday: number;
  historyDays: number;
  firstDay: number | null;
  /** fridge open days in the last 30 and days with a sale of this dish */
  openDays30: number;
  salesDays30: number;
  /** units on a sample day: usual range and a strong day */
  usual: { low: number; high: number } | null;
  strongDay: number | null;
  /** which days the norm is built on */
  basis: "FACT" | "SALES_DAYS" | null;
  sampleDays: number;
  /** KiT Shop operations, 30 days, whole units */
  loaded30: number;
  removed30: number;
  writtenOff30: number;
  stock: number;
  /** FACT: from the 5-minute stock history (30 days) */
  fact: { days: number; inStock: number; out: number; ranOut: number };
  /** ESTIMATE: from the reconstruction, only days WITHOUT facts; null = not available */
  estimate: { days: number; inStock: number; out: number; ranOut: number } | null;
  norm: { min: number; rec: number; max: number } | null;
  /** one line: "Ставить 2 шт." / "Не держать ежедневно — низкий спрос" / "Недостаточно данных" */
  recommendation: string;
  why: string[];
  status: ProductStatus;
  statusReason: string;
  quality: DataQuality;
  qualityReason: string;
  confidence: Confidence;
  confidenceReason: string;
  isNew: boolean;
  /** within the fridge by units sold in 30 days */
  demand: "HIGH" | "NORMAL" | "LOW" | null;
  /** sold in 30 days vs the 30 before, % (only with 60 days of history) */
  sales30VsPrevPct: number | null;
}

export interface ProductStats {
  /** F*P, undefined = the dish has nothing to do with this fridge */
  at: (ProductStat | undefined)[];
  byFridge: ProductStat[][];
}

const cache = new WeakMap<EngineContext, ProductStats>();
const DAY = 86_400_000;
const ddmm = (day: number) => {
  const d = new Date(day * DAY);
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const units = (n: number) => `${n} шт.`;

/** Nearest-rank quantile of whole numbers (always one of the values). */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

export function productStats(ctx: EngineContext): ProductStats {
  const hit = cache.get(ctx);
  if (hit) return hit;
  const { F, P, D, snap } = ctx;
  const pd = snap.productDays;
  const daily = snap.history.productDaily;
  const today = ctx.today;
  const historyStart = snap.historyFromDay ?? snap.history.startDay;
  const fillupsKnown30 = pd ? pd.fillupsFromDay !== null && pd.fillupsFromDay <= today - NORM.windowDays : false;

  const at: (ProductStat | undefined)[] = new Array(F * P);
  const byFridge: ProductStat[][] = snap.fridges.map(() => []);

  for (let f = 0; f < F; f++) {
    const checks = pd?.checks[f] ?? [];
    const failed = checks.filter((c) => c.level === "FAIL");
    const stockHistoryFrom = (() => {
      const c = checks.find((x) => x.id === "stock-history");
      return c && c.level !== "OK" ? c.detail : null;
    })();
    for (let p = 0; p < P; p++) {
      const base = (f * P + p) * D;
      const stock = snap.stock[f * P + p];
      const soldToday = Math.round(snap.today.productSales[f * P + p]);
      let first = pd && pd.firstDay[f * P + p] >= 0 ? pd.firstDay[f * P + p] : -1;
      if (first < 0) for (let d = 0; d < D; d++) if (daily[base + d] > 0) { first = histDay(ctx, d); break; }
      if (first < 0 && soldToday > 0) first = today;
      if (first < 0 && stock <= 0) continue;

      const sold = { d7: 0, d30: 0, d60: 0, d90: 0, d180: 0 };
      let soldPrev30 = 0;
      let openDays30 = 0;
      let salesDays30 = 0;
      let loaded30 = 0;
      let removed30 = 0;
      let writtenOff30 = 0;
      const fact = { days: 0, inStock: 0, out: 0, ranOut: 0 };
      const est = { days: 0, inStock: 0, out: 0, ranOut: 0 };
      const factSample: number[] = [];
      const salesSample30: number[] = [];
      const salesSample60: number[] = [];
      for (let d = 0; d < D; d++) {
        const day = histDay(ctx, d);
        const age = today - day;
        if (age < 1 || age > 180) continue;
        const q = Math.round(daily[base + d]);
        if (age <= 7) sold.d7 += q;
        if (age <= 30) sold.d30 += q;
        if (age <= 60) sold.d60 += q;
        if (age <= 90) sold.d90 += q;
        sold.d180 += q;
        if (age > 30 && age <= 60) soldPrev30 += q;
        if (pd && age <= 30) {
          loaded30 += pd.loaded[base + d];
          removed30 += pd.removed[base + d];
          writtenOff30 += pd.writtenOff[base + d];
        }
        if (!ctx.sample[f * D + d] || day < first) continue;
        if (age <= 60 && q > 0) salesSample60.push(q);
        if (age > 30) continue;
        openDays30++;
        if (q > 0) {
          salesDays30++;
          salesSample30.push(q);
        }
        if (!pd) continue;
        const af = pd.availFact[base + d];
        if (!Number.isNaN(af)) {
          fact.days++;
          if (af >= 0.5) {
            fact.inStock++;
            factSample.push(q);
          } else fact.out++;
          fact.ranOut += pd.ranOutFact[base + d];
        } else {
          const ae = pd.avail[base + d];
          if (!Number.isNaN(ae)) {
            est.days++;
            if (ae >= 0.5) est.inStock++;
            else est.out++;
            est.ranOut += pd.ranOut[base + d];
          }
        }
      }
      loaded30 = Math.round(loaded30);
      removed30 = Math.round(removed30);
      writtenOff30 = Math.round(writtenOff30);
      const historyDays = Math.max(0, today - Math.max(first, historyStart));
      const isNew = first >= historyStart + NORM.minHistoryDays && today - first <= NORM.newDays;

      // ── sample days
      let basis: ProductStat["basis"] = null;
      let sample: number[] = [];
      if (fact.inStock >= NORM.minFactDays) {
        basis = "FACT";
        sample = factSample;
      } else if (salesSample30.length >= NORM.minSampleDays) {
        basis = "SALES_DAYS";
        sample = salesSample30;
      } else if (salesSample60.length >= NORM.minSampleDays && historyDays >= 45) {
        basis = "SALES_DAYS";
        sample = salesSample60;
      }
      const sorted = [...sample].sort((a, b) => a - b);
      const sold30Days = sorted.length ? sorted : [...salesSample30].sort((a, b) => a - b);
      const usual = sold30Days.length ? { low: quantile(sold30Days, 0.25), high: quantile(sold30Days, 0.75) } : null;
      const strongDay = sold30Days.length ? quantile(sold30Days, 0.9) : null;

      const why: string[] = [];
      why.push(`за 30 дней продано ${units(sold.d30)}${openDays30 ? `, покупали в ${salesDays30} днях из ${openDays30}` : ""}`);
      let norm: ProductStat["norm"] = null;
      let status: ProductStatus = "NORMAL";
      let statusReason = "количество подходит";
      let recommendation = "";

      const rare = openDays30 >= 10 && salesDays30 <= NORM.rareShare * openDays30;
      if (sold.d30 === 0 && loaded30 === 0 && stock <= 0 && soldToday === 0) {
        status = "UNUSED";
        statusReason = "30 дней нет ни продаж, ни загрузок";
        recommendation = "Не используется";
      } else if (historyDays < NORM.minHistoryDays || (!rare && sorted.length < NORM.minSampleDays)) {
        status = "NO_DATA";
        statusReason = isNew ? `новое блюдо: история ${historyDays} дн.` : `мало данных: история ${historyDays} дн., дней для расчёта ${sorted.length}`;
        recommendation = "Недостаточно данных для нормы";
        if (usual) why.push(`предварительно: в день с продажами ${usual.low === usual.high ? units(usual.low) : `${usual.low}–${usual.high} шт.`}`);
      } else if (rare) {
        status = "RARE";
        const confirmed = fact.inStock >= NORM.minFactDays && salesDays30 <= NORM.rareShare * fact.inStock;
        const perSalesDay = usual ? (usual.low === usual.high ? units(usual.low) : `${usual.low}–${usual.high} шт.`) : "1 шт.";
        why.push(`обычно ${perSalesDay} за день, когда покупают`);
        if (confirmed) {
          norm = { min: 0, rec: 0, max: 1 };
          statusReason = `стоял ${fact.inStock} дн. (по истории остатков), покупали только в ${salesDays30}`;
          recommendation = "Не держать ежедневно — низкий спрос";
          why.push(`по истории остатков блюдо было в наличии ${fact.inStock} дн., а покупали в ${salesDays30}`);
        } else {
          norm = { min: 1, rec: 1, max: Math.max(1, strongDay ?? 1) };
          statusReason = `покупают редко: в ${salesDays30} днях из ${openDays30}`;
          recommendation = "Ставить 1 шт.";
          why.push("было ли блюдо в наличии в остальные дни — точно неизвестно, поэтому 1 шт.");
        }
      } else {
        const p25 = quantile(sorted, 0.25);
        const p50 = quantile(sorted, 0.5);
        const p75 = quantile(sorted, 0.75);
        const p90 = quantile(sorted, 0.9);
        let rec = Math.max(1, p75);
        const min = Math.min(rec, Math.max(1, p25));
        let max = Math.max(rec, p90);
        why.push(
          basis === "FACT"
            ? `в дни, когда блюдо было (по истории остатков, ${sorted.length} дн.), обычно уходило ${p25 === p75 ? units(p25) : `${p25}–${p75} шт.`}, в сильные дни ${units(p90)}`
            : `в дни с продажами обычно уходило ${p25 === p75 ? units(p25) : `${p25}–${p75} шт.`}, в сильные дни ${units(p90)}`,
        );
        const lossBase = loaded30;
        const lost = removed30 + writtenOff30;
        const soldOut = basis === "FACT" && fact.inStock >= NORM.minFactDays && fact.ranOut >= NORM.soldOutShare * fact.days;
        if (fillupsKnown30 && lossBase >= NORM.minLoaded && lost >= NORM.lossShare * lossBase) {
          rec = Math.max(min, p50);
          status = "LESS";
          statusReason = `из ${units(lossBase)} загруженных снято ${removed30} и списано ${writtenOff30}`;
          why.push(`загружено ${units(lossBase)}, снято ${units(removed30)}, списано ${units(writtenOff30)} — лишнее остаётся, норма по обычному дню`);
        } else if (soldOut) {
          rec = Math.min(rec + 1, max + 1);
          max = Math.max(max, rec);
          status = "MORE";
          statusReason = `закончился ${fact.ranOut} раз за ${fact.days} дн. (история остатков)`;
          why.push(`по истории остатков закончился ${fact.ranOut} раз — +1 шт.`);
        } else if (fillupsKnown30 && lossBase >= NORM.minLoaded) {
          why.push(`загружено ${units(lossBase)}, снято ${units(removed30)}, списано ${units(writtenOff30)}`);
        }
        norm = { min, rec, max };
        recommendation = `Ставить ${units(rec)}`;
        if (status === "NORMAL" && ((sold.d30 === 0 && stock > 0) || stock >= max + 3)) {
          status = "TOO_MUCH";
          statusReason = sold.d30 === 0 ? `30 дней без продаж, а в холодильнике ${units(stock)}` : `сейчас ${units(stock)}, а больше ${units(max)} в день не уходит`;
        }
      }
      if (!fillupsKnown30 && status !== "UNUSED") why.push("загрузки/снятия за 30 дней ещё не полные");

      // ── data quality
      const incomplete: string[] = [];
      if (stockHistoryFrom) incomplete.push(`точная история остатков: ${stockHistoryFrom}`);
      if (historyDays < 30) incomplete.push(`история продаж ${historyDays} дн.`);
      if (!fillupsKnown30) incomplete.push("загрузки/снятия за 30 дней неполные");
      const quality: DataQuality = failed.length ? "BAD" : incomplete.length ? "INCOMPLETE" : "GOOD";
      const qualityReason = failed.length ? `проверка не пройдена: ${failed.map((c) => c.label.toLowerCase()).join(", ")}` : incomplete.length ? incomplete.join("; ") : "продажи, загрузки и история остатков полные";
      const confidence: Confidence =
        quality === "GOOD" && sorted.length >= 15 ? "HIGH" : quality !== "BAD" && sorted.length >= 8 && historyDays >= 30 ? "MEDIUM" : "LOW";
      const confidenceReason =
        quality === "BAD"
          ? qualityReason
          : basis !== "FACT" && norm
            ? `наличие по дням не подтверждено историей остатков${stockHistoryFrom ? ` (${stockHistoryFrom})` : ""} — считаем только дни с продажами`
            : sorted.length < 8
              ? `мало дней для расчёта (${sorted.length})`
              : incomplete[0] ?? "данных достаточно";

      const st: ProductStat = {
        f,
        p,
        sold,
        soldToday,
        historyDays,
        firstDay: first,
        openDays30,
        salesDays30,
        usual,
        strongDay,
        basis,
        sampleDays: sorted.length,
        loaded30,
        removed30,
        writtenOff30,
        stock,
        fact,
        estimate: est.days ? est : null,
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

  // high / low demand inside the fridge: quartiles of units sold in 30 days
  for (const rows of byFridge) {
    const ranked = rows.filter((x) => x.sold.d30 > 0 && x.status !== "NO_DATA").sort((a, b) => b.sold.d30 - a.sold.d30);
    const q = Math.max(1, Math.floor(ranked.length / 4));
    ranked.forEach((x, i) => (x.demand = ranked.length < 4 ? "NORMAL" : i < q ? "HIGH" : i >= ranked.length - q ? "LOW" : "NORMAL"));
  }

  const out = { at, byFridge };
  cache.set(ctx, out);
  return out;
}
