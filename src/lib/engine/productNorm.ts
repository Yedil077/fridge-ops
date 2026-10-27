import { histDay, type EngineContext } from "./history";

/**
 * PRODUCT × FRIDGE analytics: how many of THIS dish to put into THIS fridge per day.
 *
 * Sales alone lie when the dish was missing: 30 sold in 30 days is 1/day only if it was there every day. So every day
 * counts with its availability (share of the fridge's sales made while the dish was on the shelf, from the stock history
 * or the reconstruction; unknown days count as "there", and the confidence stays lower).
 *
 *   sales per available day (window W) = sold in W ÷ Σ availability of the open days in W
 *   rate        = 0.35 × 7 d + 0.25 × 14 d + 0.25 × 30 d + 0.15 × 180 d   (windows without enough data are left out)
 *   adjustments = +10 % if it often ran out (≥ 25 % of selling time or ≥ 6 times in 30 d),
 *                 −10 % if a lot is taken out (write-off ≥ 15 % or unloads ≥ 30 % of what was loaded in 30 d)
 *   norm / day  = recommended max(1, ⌈rate − 0.2⌉), range max(1, round(0.75 × rate)) … ⌈1.25 × rate⌉; 0 below 0.15 / day
 *
 * The transfer recommendations take their target stock from here (engine/demand.ts) — nothing else invents a need.
 */

export const NORM = {
  windows: [
    { days: 7, weight: 0.35, minAvail: 2 },
    { days: 14, weight: 0.25, minAvail: 4 },
    { days: 30, weight: 0.25, minAvail: 8 },
    { days: 180, weight: 0.15, minAvail: 20 },
  ],
  /** "often runs out": share of selling time without stock, or times sold out, in 30 days */
  frequentOutShare: 0.25,
  frequentOutTimes: 6,
  /** "a lot is taken out" (30 days, needs at least minLoaded units loaded) */
  heavyRemovalShare: 0.3,
  heavyWriteOffShare: 0.15,
  minLoaded: 5,
  adjust: 0.1,
  /** below this many per day there is no daily norm */
  minRate: 0.15,
  /** fewer days of history at this fridge → "не хватает данных" */
  minHistoryDays: 14,
  /** appeared within this many days (and the history is older) → new */
  newDays: 21,
} as const;

export type ProductStatus = "NORMAL" | "MORE" | "TOO_MUCH" | "LESS" | "NO_DATA" | "UNUSED";
export type Confidence = "LOW" | "MEDIUM" | "HIGH";

export const STATUS_TEXT: Record<ProductStatus, string> = {
  NORMAL: "НОРМА",
  MORE: "НУЖНО БОЛЬШЕ",
  TOO_MUCH: "СЛИШКОМ МНОГО",
  LESS: "СТАВИТЬ МЕНЬШЕ",
  NO_DATA: "НЕ ХВАТАЕТ ДАННЫХ",
  UNUSED: "НЕ ИСПОЛЬЗУЕТСЯ",
};

export interface ProductStat {
  f: number;
  p: number;
  sold: { d7: number; d14: number; d30: number; d60: number; d90: number; d180: number };
  soldPrev30: number;
  soldToday: number;
  /** days of usable sales history of this dish at this fridge */
  historyDays: number;
  firstDay: number | null;
  /** fridge open (sold anything) days in the last 30 */
  openDays30: number;
  /** Σ availability of the open days in 30 d (= "days with the dish") */
  availDays30: number;
  /** open days in 30 d whose availability is really known (not assumed) */
  knownDays30: number;
  /** open days in 30 d when the dish was missing most of the selling time (known days only) */
  daysOut30: number;
  timesRanOut30: number;
  /** share of selling time without the dish, known days only; null = unknown */
  stockoutRate30: number | null;
  /** plain averages: sold ÷ open days */
  avg7: number;
  avg30: number;
  /** sales per available day */
  rate7: number | null;
  rate14: number | null;
  rate30: number | null;
  rate180: number | null;
  rate: number;
  rateAdj: number;
  /** rate 7 d vs 30 d, % */
  trendPct: number | null;
  /** sold 30 d vs the 30 d before, % */
  sales30VsPrevPct: number | null;
  loaded30: number;
  removed30: number;
  writtenOff30: number;
  /** taken out ÷ loaded, write-off ÷ loaded (30 d); null when nothing was loaded or loads are unknown */
  removedShare: number | null;
  writeOffShare: number | null;
  /** average stock at the end of the day (30 d, known days) */
  avgEod30: number | null;
  stock: number;
  /** this dish here vs the same dish in the other fridges, % */
  vsNetworkPct: number | null;
  norm: { min: number; rec: number; max: number };
  adjustments: string[];
  status: ProductStatus;
  statusReason: string;
  isNew: boolean;
  frequentlyOut: boolean;
  demand: "HIGH" | "NORMAL" | "LOW" | null;
  confidence: Confidence;
  availabilityKnown: boolean;
}

export interface ProductStats {
  /** F*P, undefined = the dish has nothing to do with this fridge */
  at: (ProductStat | undefined)[];
  byFridge: ProductStat[][];
}

const cache = new WeakMap<EngineContext, ProductStats>();
const r1 = (x: number) => Math.round(x * 10) / 10;
const pct = (a: number, b: number) => Math.round((a / b - 1) * 100);

export function normOf(rateAdj: number): { min: number; rec: number; max: number } {
  if (rateAdj < NORM.minRate) return { min: 0, rec: 0, max: 0 };
  const rec = Math.max(1, Math.ceil(rateAdj - 0.2));
  return { min: Math.min(rec, Math.max(1, Math.round(rateAdj * 0.75))), rec, max: Math.max(rec, Math.ceil(rateAdj * 1.25)) };
}

export function productStats(ctx: EngineContext): ProductStats {
  const hit = cache.get(ctx);
  if (hit) return hit;
  const { F, P, D, snap } = ctx;
  const pd = snap.productDays;
  const daily = snap.history.productDaily;
  const today = ctx.today;
  const historyStart = snap.historyFromDay ?? snap.history.startDay;
  const fillupsKnown30 = pd ? pd.fillupsFromDay !== null && pd.fillupsFromDay <= today - 30 : false;

  const at: (ProductStat | undefined)[] = new Array(F * P);
  const byFridge: ProductStat[][] = snap.fridges.map(() => []);

  for (let f = 0; f < F; f++) {
    for (let p = 0; p < P; p++) {
      const base = (f * P + p) * D;
      const stock = snap.stock[f * P + p];
      const soldToday = snap.today.productSales[f * P + p];
      // first appearance: KiT Shop facts, else the first day with a sale
      let first = pd && pd.firstDay[f * P + p] >= 0 ? pd.firstDay[f * P + p] : -1;
      if (first < 0) for (let d = 0; d < D; d++) if (daily[base + d] > 0) { first = histDay(ctx, d); break; }
      if (first < 0 && soldToday > 0) first = today;
      if (first < 0 && stock <= 0) continue;

      const sold = { d7: 0, d14: 0, d30: 0, d60: 0, d90: 0, d180: 0 };
      let soldPrev30 = 0;
      const win = new Map<number, { sold: number; avail: number }>(NORM.windows.map((w) => [w.days, { sold: 0, avail: 0 }]));
      let openDays30 = 0;
      let open7 = 0;
      let availDays30 = 0;
      let knownDays30 = 0;
      let knownAvail30 = 0;
      let daysOut30 = 0;
      let timesRanOut30 = 0;
      let loaded30 = 0;
      let removed30 = 0;
      let writtenOff30 = 0;
      let eodSum = 0;
      let eodN = 0;
      for (let d = 0; d < D; d++) {
        const day = histDay(ctx, d);
        const age = today - day; // 1 = yesterday
        if (age < 1 || age > 180) continue;
        const q = daily[base + d];
        if (age <= 7) sold.d7 += q;
        if (age <= 14) sold.d14 += q;
        if (age <= 30) sold.d30 += q;
        if (age <= 60) sold.d60 += q;
        if (age <= 90) sold.d90 += q;
        sold.d180 += q;
        if (age > 30 && age <= 60) soldPrev30 += q;
        if (pd && age <= 30) {
          loaded30 += pd.loaded[base + d];
          removed30 += pd.removed[base + d];
          writtenOff30 += pd.writtenOff[base + d];
          timesRanOut30 += pd.ranOut[base + d];
          if (!Number.isNaN(pd.eod[base + d])) {
            eodSum += pd.eod[base + d];
            eodN++;
          }
        }
        // an open day of the fridge after the dish appeared
        if (!ctx.sample[f * D + d] || day < first) continue;
        const known = pd ? !Number.isNaN(pd.avail[base + d]) : false;
        const a = known ? pd!.avail[base + d] : 1;
        for (const w of NORM.windows)
          if (age <= w.days) {
            const x = win.get(w.days)!;
            x.sold += q;
            x.avail += a;
          }
        if (age <= 7) open7++;
        if (age <= 30) {
          openDays30++;
          availDays30 += a;
          if (known) {
            knownDays30++;
            knownAvail30 += a;
            if (a < 0.5) daysOut30++;
          }
        }
      }

      const rateOf = (days: number) => {
        const x = win.get(days)!;
        const w = NORM.windows.find((y) => y.days === days)!;
        return x.avail >= w.minAvail ? x.sold / x.avail : null;
      };
      const rates = NORM.windows.map((w) => ({ w, r: rateOf(w.days) }));
      const usable = rates.filter((x) => x.r !== null);
      const all180 = win.get(180)!;
      const rate = usable.length
        ? usable.reduce((a, x) => a + x.w.weight * x.r!, 0) / usable.reduce((a, x) => a + x.w.weight, 0)
        : all180.avail > 0
          ? all180.sold / all180.avail
          : 0;
      const stockoutRate30 = knownDays30 > 0 ? 1 - knownAvail30 / knownDays30 : null;
      const frequentlyOut = (stockoutRate30 !== null && knownDays30 >= 5 && stockoutRate30 >= NORM.frequentOutShare) || timesRanOut30 >= NORM.frequentOutTimes;
      const removedShare = fillupsKnown30 && loaded30 > 0 ? removed30 / loaded30 : null;
      const writeOffShare = fillupsKnown30 && loaded30 > 0 ? writtenOff30 / loaded30 : null;
      const heavy =
        !frequentlyOut &&
        loaded30 >= NORM.minLoaded &&
        ((writeOffShare ?? 0) >= NORM.heavyWriteOffShare || (removedShare ?? 0) >= NORM.heavyRemovalShare);
      const adjustments: string[] = [];
      let rateAdj = rate;
      if (frequentlyOut && rate > 0) {
        rateAdj = rate * (1 + NORM.adjust);
        adjustments.push(
          `часто заканчивался (${stockoutRate30 !== null && knownDays30 >= 5 ? `без товара ${Math.round(stockoutRate30 * 100)}% времени продаж` : `${timesRanOut30} раз за 30 дней`}) → +10%`,
        );
      }
      if (heavy) {
        rateAdj = rate * (1 - NORM.adjust);
        adjustments.push(
          (writeOffShare ?? 0) >= NORM.heavyWriteOffShare
            ? `списано ${Math.round(writeOffShare! * 100)}% загруженного → −10%`
            : `снято ${Math.round(removedShare! * 100)}% загруженного → −10%`,
        );
      }
      const norm = normOf(rateAdj);
      const rate7 = rateOf(7);
      const rate30 = rateOf(30);
      const historyDays = Math.max(0, today - Math.max(first, historyStart));
      const isNew = first >= historyStart + NORM.minHistoryDays && today - first <= NORM.newDays;
      const avgEod30 = eodN >= 5 ? eodSum / eodN : null;

      let status: ProductStatus = "NORMAL";
      let statusReason = "количество подходит";
      if (sold.d30 === 0 && loaded30 === 0 && stock <= 0 && soldToday === 0) {
        status = "UNUSED";
        statusReason = "30 дней нет ни продаж, ни загрузок";
      } else if (historyDays < NORM.minHistoryDays || all180.avail < 5) {
        status = "NO_DATA";
        statusReason = isNew ? `новый товар: история ${historyDays} дн.` : `мало истории (${historyDays} дн., с товаром ${r1(all180.avail)} дн.)`;
      } else if (frequentlyOut) {
        status = "MORE";
        statusReason = adjustments[0] ?? "часто заканчивается";
      } else if (heavy) {
        status = "LESS";
        statusReason = adjustments[adjustments.length - 1];
      } else if (sold.d30 === 0 && stock > 0) {
        status = "TOO_MUCH";
        statusReason = `30 дней без продаж, а в холодильнике ${stock}`;
      } else if ((avgEod30 !== null && avgEod30 >= Math.max(3, 2 * rateAdj)) || (norm.rec > 0 && stock >= Math.max(4, 3 * norm.rec))) {
        status = "TOO_MUCH";
        statusReason =
          avgEod30 !== null && avgEod30 >= Math.max(3, 2 * rateAdj)
            ? `к вечеру обычно остаётся ${r1(avgEod30)} при продажах ${r1(rateAdj)}/день`
            : `сейчас ${stock}, а норма ${norm.rec}/день`;
      }

      const knownAvail = knownDays30 > 0;
      const confidence: Confidence =
        historyDays < NORM.minHistoryDays || all180.avail < 14 ? "LOW" : all180.avail >= 40 && knownDays30 >= 15 ? "HIGH" : "MEDIUM";

      const st: ProductStat = {
        f,
        p,
        sold,
        soldPrev30,
        soldToday,
        historyDays,
        firstDay: first,
        openDays30,
        availDays30: r1(availDays30),
        knownDays30,
        daysOut30,
        timesRanOut30,
        stockoutRate30: stockoutRate30 === null ? null : Math.round(stockoutRate30 * 100) / 100,
        avg7: open7 ? r1(sold.d7 / open7) : 0,
        avg30: openDays30 ? r1(sold.d30 / openDays30) : 0,
        rate7: rate7 === null ? null : r1(rate7),
        rate14: rateOf(14) === null ? null : r1(rateOf(14)!),
        rate30: rate30 === null ? null : r1(rate30),
        rate180: rateOf(180) === null ? null : r1(rateOf(180)!),
        rate: r1(rate),
        rateAdj: Math.round(rateAdj * 100) / 100,
        trendPct: rate7 !== null && rate30 !== null && rate30 > 0 ? pct(rate7, rate30) : null,
        sales30VsPrevPct: historyDays >= 60 && soldPrev30 > 0 ? pct(sold.d30, soldPrev30) : null,
        loaded30,
        removed30,
        writtenOff30,
        removedShare: removedShare === null ? null : Math.round(removedShare * 100) / 100,
        writeOffShare: writeOffShare === null ? null : Math.round(writeOffShare * 100) / 100,
        avgEod30: avgEod30 === null ? null : r1(avgEod30),
        stock,
        vsNetworkPct: null,
        norm,
        adjustments,
        status,
        statusReason,
        isNew,
        frequentlyOut,
        demand: null,
        confidence,
        availabilityKnown: knownAvail,
      };
      at[f * P + p] = st;
      byFridge[f].push(st);
    }
  }

  // the same dish in the other fridges
  for (let p = 0; p < P; p++) {
    const rows = snap.fridges.map((_, f) => at[f * P + p]).filter((x): x is ProductStat => !!x && x.rate > 0 && x.status !== "NO_DATA");
    for (const st of rows) {
      const others = rows.filter((x) => x !== st);
      if (others.length < 2) continue;
      const avg = others.reduce((a, x) => a + x.rate, 0) / others.length;
      if (avg > 0) st.vsNetworkPct = pct(st.rate, avg);
    }
  }
  // high / low demand inside the fridge (quartiles of the rate)
  for (const rows of byFridge) {
    const ranked = rows.filter((x) => x.rate > 0 && x.status !== "NO_DATA" && x.status !== "UNUSED").sort((a, b) => b.rate - a.rate);
    const q = Math.max(1, Math.floor(ranked.length / 4));
    ranked.forEach((x, i) => (x.demand = ranked.length < 4 ? "NORMAL" : i < q ? "HIGH" : i >= ranked.length - q ? "LOW" : "NORMAL"));
  }

  const out = { at, byFridge };
  cache.set(ctx, out);
  return out;
}
