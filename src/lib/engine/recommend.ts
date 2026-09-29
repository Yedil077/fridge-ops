import { ENGINE_CONFIG } from "../config/engine";
import type {
  CategoryForecast,
  ExplanationLine,
  FridgeForecast,
  Mission,
  MissionLine,
  MissionProduct,
  MissionStop,
  MissionType,
  MissionUrgency,
} from "../domain/types";
import { fmtDuration, fmtHM, weekdayOf, weekdayPlural } from "../time";
import { distanceFactor } from "./distance";
import { sumWindow } from "./forecast";
import { sameWeekdayWindowSales, type EngineContext } from "./history";
import { productModel, type ProductModel } from "./products";
import { wasteUnits } from "./risk";

/**
 * Recommendation engine.
 *  1. Category level (robust forecasts): where is a shortage, where is a safe surplus.
 *  2. Product level: WHICH dishes to take — NEED(target, dish) = expected demand + safety − stock,
 *     capped by the safe surplus of the same dish at the source, ranked by fridge × product affinity.
 *  3. Routes: moves from the same pick-up fridge are merged into one route with ordered stops.
 */

export interface Reservation {
  sourceIndex: number;
  targetIndex: number;
  categoryIndex: number;
  qty: number;
  products?: { productIndex: number; qty: number }[];
}

export interface PairStat {
  moved: number;
  sold: number;
  count: number;
}

export type MissionDraft = Pick<
  Mission,
  | "type"
  | "title"
  | "priority"
  | "priorityLabel"
  | "urgency"
  | "sourceFridgeId"
  | "targetFridgeId"
  | "stops"
  | "travelMinutes"
  | "lines"
  | "headline"
  | "effect"
>;

export const pairKey = (sourceId: string, targetId: string, categoryId: string) => `${sourceId}>${targetId}:${categoryId}`;

const CAT_EN: Record<string, string> = {
  breakfast: "BREAKFAST",
  hot: "HOT MEAL",
  salad: "SALAD",
  snack: "SNACK",
  dessert: "DESSERT",
  drink: "DRINKS",
};

/** Genitive for headlines ("без горячего"). */
const CAT_GEN: Record<string, string> = {
  breakfast: "завтраков",
  hot: "горячего",
  salad: "салатов",
  snack: "перекусов",
  dessert: "десертов",
  drink: "напитков",
};

interface Slot {
  deficit: number;
  capacity: number;
  surplus: number;
  waste: number;
  keep: number;
  cover: number;
  inbound: number;
  outbound: number;
}

export function pairFactor(stats: Record<string, PairStat>, key: string): { factor: number; rate: number; stat?: PairStat } {
  const { pairPrior, pairPriorWeight, pairFactorMin, pairFactorMax } = ENGINE_CONFIG.learning;
  const s = stats[key];
  const rate = s ? (s.sold + pairPriorWeight * pairPrior) / (s.moved + pairPriorWeight) : pairPrior;
  return { factor: Math.min(pairFactorMax, Math.max(pairFactorMin, rate / pairPrior)), rate, stat: s };
}

function priorityLabel(p: number): Mission["priorityLabel"] {
  const l = ENGINE_CONFIG.priority.labels;
  return p >= l.critical ? "CRITICAL" : p >= l.high ? "HIGH" : p >= l.medium ? "MEDIUM" : "LOW";
}

const r1 = (v: number) => (Math.round(v * 10) / 10).toString().replace(".", ",");
const rng = (a: [number, number]) => (a[0] === a[1] ? `${a[0]}` : `${a[0]}–${a[1]}`);

export function buildSlots(ctx: EngineContext, forecasts: FridgeForecast[], reservations: Reservation[]): Slot[][] {
  const T = ENGINE_CONFIG.transfer;
  const inbound = forecasts.map(() => new Array<number>(ctx.C).fill(0));
  const outbound = forecasts.map(() => new Array<number>(ctx.C).fill(0));
  for (const r of reservations) {
    inbound[r.targetIndex][r.categoryIndex] += r.qty;
    outbound[r.sourceIndex][r.categoryIndex] += r.qty;
  }
  return forecasts.map((ff, f) =>
    ff.categories.map((cf, c) => {
      const fr = ctx.snap.fridges[f];
      const targetEligible = ff.isOpenNow && ff.minutesToClose >= T.minTargetOpenMinutes;
      const sourceEligible = ff.isOpenNow || (T.allowClosedSource && ff.isWorkingToday);
      const coverMin = Math.min(T.targetCoverHours * 60, ff.minutesToClose);
      const nowFrom = Math.max(ctx.nowMinute, fr.openingMinute);
      const cover = sumWindow(cf.forecastHourly, nowFrom, nowFrom + coverMin);
      const stockIn = cf.stock + inbound[f][c];
      const deficit = targetEligible ? Math.max(0, Math.ceil(cover + cf.safetyStock - stockIn)) : 0;
      const capacity = targetEligible ? Math.max(0, Math.floor(T.absorbRatio * cf.expectedUntilClose - stockIn)) : 0;
      // source keeps enough for the next check + safety, or its (upper) expected sales until close
      const upperClose = cf.expectedUntilClose + (1 - cf.confidence) * (cf.intervalClose[1] - cf.expectedUntilClose);
      const keep = Math.max(cf.expected2h + cf.safetyStock, upperClose * T.sourceKeepCloseRatio);
      const surplus = sourceEligible ? Math.max(0, Math.floor(cf.stock - outbound[f][c] - keep)) : 0;
      const waste = sourceEligible ? Math.max(0, cf.wasteUnits - outbound[f][c] * ctx.snap.categories[c].wasteShare[ff.isWorkingTomorrow ? 0 : 1]) : 0;
      return { deficit, capacity, surplus, waste, keep, cover, inbound: inbound[f][c], outbound: outbound[f][c] };
    }),
  );
}

// ───────────────────────── product-level allocation ─────────────────────────

interface ProductLedger {
  /** units already promised away from a source, F*P */
  taken: Float64Array;
  /** units already promised to a target, F*P */
  sent: Float64Array;
}

interface Alloc {
  productIndex: number;
  qty: number;
}

/**
 * Picks concrete dishes for a category move.
 * A dish goes to the target only if the target NEEDS it (need = demand share + safety − stock − already sent)
 * and the source has it BEYOND its own keep for that dish. Ranked by target affinity.
 */
function allocateProducts(
  ctx: EngineContext,
  pm: ProductModel,
  forecasts: FridgeForecast[],
  slots: Slot[][],
  ledger: ProductLedger,
  s: number,
  t: number,
  c: number,
  maxQty: number,
  rescue: boolean,
): Alloc[] {
  const { P } = ctx;
  const prods = ctx.catProducts[c];
  const src = slots[s][c];
  const tgt = slots[t][c];
  const tf = forecasts[t].categories[c];
  const T = ENGINE_CONFIG.transfer;
  const surplus = prods.map((p) =>
    Math.floor(ctx.snap.stock[s * P + p] - ledger.taken[s * P + p] - src.keep * pm.share[s * P + p]),
  );
  const want = prods.map((p) => {
    const sh = pm.share[t * P + p];
    const have = ctx.snap.stock[t * P + p] + ledger.sent[t * P + p];
    const need = Math.ceil(tgt.cover * sh + tf.safetyStock * sh - have);
    const absorb = rescue ? Math.floor(T.absorbRatio * tf.expectedUntilClose * sh - have) : 0;
    return Math.max(need, absorb);
  });
  const alloc = prods.map(() => 0);
  let total = 0;
  while (total < maxQty) {
    let best = -1;
    let bestScore = 0;
    prods.forEach((p, k) => {
      const room = Math.min(surplus[k], want[k]) - alloc[k];
      if (room <= 0) return;
      const score = (want[k] - alloc[k]) * (0.5 + pm.affinity[t * P + p] / 100);
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    });
    if (best < 0) break;
    alloc[best]++;
    total++;
  }
  return prods.map((p, k) => ({ productIndex: p, qty: alloc[k] })).filter((a) => a.qty > 0);
}

// ───────────────────────── candidates ─────────────────────────

interface Candidate {
  s: number;
  t: number;
  c: number;
  qty: number;
  products: Alloc[];
  priority: number;
  scores: MissionLine["scores"];
  rescue: boolean;
}

function evaluateCandidate(
  ctx: EngineContext,
  pm: ProductModel,
  forecasts: FridgeForecast[],
  slots: Slot[][],
  ledger: ProductLedger,
  pairStats: Record<string, PairStat>,
  s: number,
  t: number,
  c: number,
): Candidate | null {
  const T = ENGINE_CONFIG.transfer;
  const W = ENGINE_CONFIG.priority;
  const src = slots[s][c];
  const tgt = slots[t][c];
  if (src.surplus <= 0) return null;
  const travel = ctx.snap.travelMinutes[s][t];
  const dist = distanceFactor(travel);
  if (dist <= 0) return null;
  const sourceOverstock = forecasts[s].categories[c].state === "OVERSTOCK";
  const rescueMode = src.waste > 0 || sourceOverstock;
  const rescueQty = rescueMode ? Math.min(tgt.capacity, src.waste > 0 ? Math.ceil(src.waste) : src.surplus) : 0;
  const want = Math.max(tgt.deficit, rescueQty);
  if (want <= 0) return null;
  const tf = forecasts[t].categories[c];
  let qty = Math.min(src.surplus, want);
  qty = Math.floor(qty * (T.confidenceFloor + (1 - T.confidenceFloor) * tf.confidence));
  if (qty < T.minQty) return null;
  const products = allocateProducts(ctx, pm, forecasts, slots, ledger, s, t, c, qty, rescueMode && tgt.deficit < qty);
  qty = products.reduce((a, x) => a + x.qty, 0);
  if (qty < (ctx.snap.categories[c].core ? T.minQty : T.minQtyNonCore)) return null;

  const pf = pairFactor(pairStats, pairKey(ctx.snap.fridges[s].id, ctx.snap.fridges[t].id, ctx.snap.categories[c].id));
  const shortage = Math.min(1, tgt.deficit / Math.max(tf.expected2h, 1) + (tf.minutesToEmpty !== null && tf.minutesToEmpty <= 60 ? 0.2 : 0));
  const waste = Math.min(1, Math.min(qty, src.waste) / W.wasteNormUnits);
  const sellable = Math.min(qty, Math.max(0, Math.ceil(tf.expectedUntilClose - tf.stock - tgt.inbound)));
  const opportunity = Math.min(1, (sellable * pf.factor) / W.opportunityNormUnits);
  const hoursToEmpty = tf.minutesToEmpty === null ? Infinity : tf.minutesToEmpty / 60;
  const urgency = Math.min(1, Math.max(0, 1 - hoursToEmpty / W.urgencyHorizonHours));
  const raw = W.weights.shortage * shortage + W.weights.waste * waste + W.weights.opportunity * opportunity + W.weights.urgency * urgency;
  const conf = Math.min(tf.confidence, forecasts[s].categories[c].confidence);
  const importance = [0.9, 1, 1.15][ctx.snap.fridges[t].priority - 1] ?? 1;
  const priority = Math.min(100, Math.round(100 * raw * (W.confidenceBase + (1 - W.confidenceBase) * conf) * dist * pf.factor * importance));
  return {
    s, t, c, qty, products, priority,
    scores: { shortage, waste, opportunity, urgency, distance: dist, pair: pf.factor },
    rescue: tgt.deficit < qty / 2 && src.waste > 0,
  };
}

// ───────────────────────── explanations ─────────────────────────

function explainLine(
  ctx: EngineContext,
  pm: ProductModel,
  forecasts: FridgeForecast[],
  slots: Slot[][],
  pairStats: Record<string, PairStat>,
  cand: Candidate,
): MissionLine {
  const { s, t, c, qty } = cand;
  const { P } = ctx;
  const cat = ctx.snap.categories[c];
  const src = forecasts[s].categories[c];
  const tgt = forecasts[t].categories[c];
  const ss = slots[s][c];
  const ts = slots[t][c];
  const srcF = ctx.snap.fridges[s];
  const tgtF = ctx.snap.fridges[t];
  const nowFrom = Math.max(ctx.nowMinute, tgtF.openingMinute);
  const windowEnd = Math.min(tgtF.closingMinute, nowFrom + ENGINE_CONFIG.riskHorizonMinutes);
  const normalWindow = sumWindow(tgt.normalHourly, nowFrom, windowEnd);
  const lastSame = sameWeekdayWindowSales(ctx, t, c, nowFrom, windowEnd, 4);
  const pacePct = Math.round((tgt.pace - 1) * 100);
  const pf = pairFactor(pairStats, pairKey(srcF.id, tgtF.id, cat.id));

  const products: MissionProduct[] = cand.products
    .map((a) => {
      const pr = ctx.snap.products[a.productIndex];
      return {
        productId: pr.id,
        name: pr.name,
        sku: pr.sku,
        qty: a.qty,
        actualQty: null,
        targetAffinity: pm.affinity[t * P + a.productIndex],
        sourceAffinity: pm.affinity[s * P + a.productIndex],
        targetPerDay: Math.round(pm.perDay[t * P + a.productIndex] * 10) / 10,
        sourcePerDay: Math.round(pm.perDay[s * P + a.productIndex] * 10) / 10,
      };
    })
    .sort((a, b) => b.qty - a.qty);

  const target: ExplanationLine[] = [
    { label: "Сейчас в наличии", value: `${tgt.stock} шт.` },
    { label: `Обычно продаёт ${fmtHM(nowFrom)}–${fmtHM(windowEnd)}`, value: `${r1(normalWindow)} шт.` },
  ];
  if (lastSame.length) target.push({ label: `Последние ${weekdayPlural(weekdayOf(ctx.today))}`, value: lastSame.join(" / ") });
  target.push({ label: "Темп сегодня", value: `${pacePct >= 0 ? "+" : ""}${pacePct}% к норме` });
  target.push({ label: "Скорость", value: `${r1(tgt.velocity)} шт./ч` });
  target.push({ label: "Прогноз на 2 ч", value: `${rng(tgt.interval2h)} шт.` });
  if (tgt.minutesToEmpty !== null) target.push({ label: "Закончится через", value: `~${fmtDuration(tgt.minutesToEmpty)}`, emphasis: true });
  if (ts.deficit > 0) target.push({ label: "Ожидаемый дефицит", value: `${ts.deficit} шт.`, emphasis: true });
  else target.push({ label: "Может продать до закрытия", value: `ещё ~${Math.max(0, Math.round(tgt.expectedUntilClose - tgt.stock))} шт.` });

  const source: ExplanationLine[] = [
    { label: "Сейчас в наличии", value: `${src.stock} шт.` },
    { label: `Прогноз до закрытия (${fmtHM(srcF.closingMinute)})`, value: `${rng(src.intervalClose)} шт.` },
    { label: "Оставляем себе (запас)", value: `${Math.ceil(ss.keep)} шт.` },
    { label: "Безопасный излишек", value: `${ss.surplus} шт.`, emphasis: true },
  ];
  if (src.wasteUnits >= 1)
    source.push({
      label: forecasts[s].isWorkingTomorrow ? "Риск списания к закрытию" : "Риск списания (завтра выходной)",
      value: `~${Math.round(src.wasteUnits)} шт.`,
      emphasis: true,
    });

  const decision: ExplanationLine[] = [
    { label: "Уверенность прогноза", value: `${Math.round(tgt.confidence * 100)}%` },
    { label: "Основа прогноза", value: tgt.baseline.label },
  ];
  if (tgt.confidence < 0.7) decision.push({ label: "Осторожность", value: "низкая уверенность → объём снижен" });
  if (pf.stat && pf.stat.moved >= 5)
    decision.push({ label: "Этот маршрут раньше", value: `продано ${pf.stat.sold} из ${pf.stat.moved} (${Math.round((pf.stat.sold / pf.stat.moved) * 100)}%)` });
  for (const p of products.slice(0, 3))
    decision.push({ label: `${p.name}`, value: `${tgtF.name}: ${r1(p.targetPerDay)}/день · ${srcF.name}: ${r1(p.sourcePerDay)}/день` });
  decision.push({ label: "Рекомендуем", value: `${qty} шт.`, emphasis: true });

  // short plain sentences for the phone
  const short: string[] = [];
  if (ts.deficit > 0) {
    short.push(`${tgtF.name} обычно продаёт ~${Math.round(normalWindow)} (${cat.name.toLowerCase()}) с ${fmtHM(nowFrom)} до ${fmtHM(windowEnd)}. Сейчас осталось ${tgt.stock}.`);
  } else {
    short.push(`${srcF.name}: ${ss.surplus} лишних (${cat.name.toLowerCase()}) — до закрытия там не продадутся.`);
  }
  if (Math.abs(pacePct) >= 8) short.push(`Сегодня продажи ${pacePct > 0 ? "на " + pacePct + "% выше" : "на " + -pacePct + "% ниже"} обычного.`);
  if (ts.deficit > 0) short.push(`${srcF.name} имеет ${ss.surplus} лишних порций${src.wasteUnits >= 1 ? `, иначе ~${Math.round(src.wasteUnits)} уйдут в списание` : ""}.`);
  else short.push(`${tgtF.name} успеет их продать до закрытия.`);
  const lead = products[0];
  if (lead && lead.targetPerDay > lead.sourcePerDay * 1.2)
    short.push(`«${lead.name}» в ${tgtF.name} продаётся ${r1(lead.targetPerDay)}/день, в ${srcF.name} — ${r1(lead.sourcePerDay)}.`);

  const summary =
    ts.deficit > 0
      ? `${tgtF.name}: ${tgt.stock} шт., а за ${fmtDuration(windowEnd - nowFrom)} ожидается ${rng(tgt.interval2h)}. ${srcF.name} имеет безопасный излишек ${ss.surplus}.`
      : `${srcF.name}: излишек ${cat.name.toLowerCase()} ~${ss.surplus} шт.${src.wasteUnits >= 1 ? `, риск списания ~${Math.round(src.wasteUnits)}` : ""}. ${tgtF.name} продаст их до закрытия.`;

  return {
    categoryId: cat.id,
    targetFridgeId: tgtF.id,
    recommendedQty: qty,
    qtyRange: [Math.max(ENGINE_CONFIG.transfer.minQty, Math.round(qty * 0.8)), Math.max(qty, Math.min(ss.surplus, Math.ceil(qty * 1.2)))],
    actualQty: null,
    products,
    expectedShortage: ts.deficit,
    expectedSurplus: ss.surplus,
    sourceWasteUnits: Math.round(src.wasteUnits * 10) / 10,
    targetStockBefore: tgt.stock,
    sourceStockBefore: src.stock,
    predictedTargetSales2h: Math.round(tgt.expected2h * 10) / 10,
    confidence: tgt.confidence,
    why: { summary, short, target, source, decision },
    scores: cand.scores,
  };
}

/** Expected effect of one stop: waste risk at source and how long the target lasts, before → after. */
function effectOf(
  ctx: EngineContext,
  forecasts: FridgeForecast[],
  s: number,
  t: number,
  lines: { c: number; qty: number }[],
  routeLines: { c: number; qty: number }[] | null,
): ExplanationLine[] {
  const wasteRisk = (f: number, delta: Map<number, number>) => {
    const ff = forecasts[f];
    let w = 0;
    let stock = 0;
    ff.categories.forEach((cf, c) => {
      const st = cf.stock + (delta.get(c) ?? 0);
      w += wasteUnits(ctx.snap.categories[c], st, cf.expectedUntilClose, ff.isWorkingTomorrow);
      stock += st;
    });
    return stock > 0 ? w / stock : 0;
  };
  const availability = (f: number, delta: Map<number, number>) => {
    const ff = forecasts[f];
    let ok = 0;
    let tot = 0;
    ff.categories.forEach((cf: CategoryForecast, c) => {
      if (!ctx.snap.categories[c].core) return;
      const w = cf.expected2h + 0.1;
      tot += w;
      const st = cf.stock + (delta.get(c) ?? 0);
      ok += w * Math.min(1, st / Math.max(0.5, cf.expected2h));
    });
    return tot > 0 ? ok / tot : 1;
  };
  const minus = new Map<number, number>();
  for (const l of routeLines ?? []) minus.set(l.c, (minus.get(l.c) ?? 0) - l.qty);
  const plus = new Map(lines.map((l) => [l.c, l.qty]));
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const out: ExplanationLine[] = [];
  const w0 = wasteRisk(s, new Map());
  const w1 = wasteRisk(s, minus);
  // source effect is reported once per route (routeLines only on the first stop)
  if (routeLines && w0 - w1 >= 0.005) out.push({ label: `Риск списания ${ctx.snap.fridges[s].name}`, value: `${pct(w0)} → ${pct(w1)}` });
  const a0 = availability(t, new Map());
  const a1 = availability(t, plus);
  if (a1 - a0 >= 0.005) out.push({ label: `Доступность ${ctx.snap.fridges[t].name} (2 ч)`, value: `${pct(a0)} → ${pct(a1)}` });
  const lead = lines.reduce((a, b) => (b.qty > a.qty ? b : a));
  const cf = forecasts[t].categories[lead.c];
  const fr = ctx.snap.fridges[t];
  const lasts = (stock: number) => {
    const from = Math.max(ctx.nowMinute, fr.openingMinute);
    let cum = 0;
    for (let m = from; m < fr.closingMinute; m += 5) {
      cum += cf.forecastHourly[Math.floor(m / 60)] / 12;
      if (cum >= stock) return fmtDuration(m + 5 - ctx.nowMinute);
    }
    return "до закрытия";
  };
  const before = cf.stock <= 0 ? "пусто" : lasts(cf.stock);
  const after = lasts(cf.stock + lead.qty);
  if (before !== after) out.push({ label: `${ctx.snap.categories[lead.c].emoji} хватит в ${fr.name}`, value: `${before} → ${after}` });
  return out;
}

/** Nearest-neighbour order of stops starting from the pick-up fridge. */
function orderStops(ctx: EngineContext, s: number, targets: number[]): { t: number; leg: number }[] {
  const left = [...targets];
  const out: { t: number; leg: number }[] = [];
  let at = s;
  while (left.length) {
    let bi = 0;
    for (let i = 1; i < left.length; i++) if (ctx.snap.travelMinutes[at][left[i]] < ctx.snap.travelMinutes[at][left[bi]]) bi = i;
    const t = left.splice(bi, 1)[0];
    out.push({ t, leg: ctx.snap.travelMinutes[at][t] });
    at = t;
  }
  return out;
}

export function urgencyOf(priority: number, minutesToEmpty: number | null): MissionUrgency {
  const u = ENGINE_CONFIG.priority.urgency;
  if (priority >= u.now || (minutesToEmpty !== null && minutesToEmpty <= u.nowMinutesToEmpty && priority >= u.today)) return "NOW";
  if (priority >= u.today) return "TODAY";
  return "LATER";
}

export function recommend(
  ctx: EngineContext,
  forecasts: FridgeForecast[],
  reservations: Reservation[],
  pairStats: Record<string, PairStat>,
): MissionDraft[] {
  const T = ENGINE_CONFIG.transfer;
  const pm = productModel(ctx);
  const slots = buildSlots(ctx, forecasts, reservations);
  const ledger: ProductLedger = { taken: new Float64Array(ctx.F * ctx.P), sent: new Float64Array(ctx.F * ctx.P) };
  for (const r of reservations)
    for (const p of r.products ?? []) {
      ledger.taken[r.sourceIndex * ctx.P + p.productIndex] += p.qty;
      ledger.sent[r.targetIndex * ctx.P + p.productIndex] += p.qty;
    }

  const chosen: Candidate[] = [];
  const blockedAsSource = new Set<string>(); // "f:c" — a target of c must not also give c away
  const blockedAsTarget = new Set<string>();
  const stopsBySource = new Map<number, Set<number>>();
  const targetSources = new Map<string, number>(); // "t:c" → number of sources

  for (let iter = 0; iter < 60; iter++) {
    let best: Candidate | null = null;
    let bestScore = 0;
    for (let c = 0; c < ctx.C; c++) {
      for (let t = 0; t < ctx.F; t++) {
        if (blockedAsTarget.has(`${t}:${c}`)) continue;
        if (slots[t][c].deficit <= 0 && slots[t][c].capacity <= 0) continue;
        for (let s = 0; s < ctx.F; s++) {
          if (s === t || blockedAsSource.has(`${s}:${c}`) || blockedAsTarget.has(`${s}:${c}`)) continue;
          const stops = stopsBySource.get(s);
          if (!stops) {
            if (stopsBySource.size >= T.maxRoutes) continue;
          } else if (!stops.has(t) && stops.size >= T.maxStopsPerRoute) continue;
          const cand = evaluateCandidate(ctx, pm, forecasts, slots, ledger, pairStats, s, t, c);
          if (!cand) continue;
          const fed = targetSources.get(`${t}:${c}`) ?? 0;
          if (fed >= T.maxSourcesPerTarget || (fed > 0 && cand.qty < T.extraSourceMinQty)) continue;
          if (stops && !stops.has(t)) {
            if (cand.priority < T.minStopPriority) continue;
            const points = [s, ...stops];
            const near = Math.min(...points.map((x) => ctx.snap.travelMinutes[x][t]));
            if (near > T.maxAddStopMinutes) continue;
            const legs = orderStops(ctx, s, [...stops, t]).reduce((a, x) => a + x.leg, 0);
            if (legs > T.maxRouteMinutes) continue;
          }
          const score = cand.priority * (stops ? T.sameRouteBonus : 1);
          if (score > bestScore) {
            bestScore = score;
            best = cand;
          }
        }
      }
    }
    if (!best || best.priority < T.minPriority) break;
    chosen.push(best);
    const src = slots[best.s][best.c];
    const tgt = slots[best.t][best.c];
    src.surplus -= best.qty;
    src.waste = Math.max(0, src.waste - best.qty);
    tgt.deficit = Math.max(0, tgt.deficit - best.qty);
    tgt.capacity = Math.max(0, tgt.capacity - best.qty);
    tgt.inbound += best.qty;
    for (const a of best.products) {
      ledger.taken[best.s * ctx.P + a.productIndex] += a.qty;
      ledger.sent[best.t * ctx.P + a.productIndex] += a.qty;
    }
    blockedAsSource.add(`${best.t}:${best.c}`);
    blockedAsTarget.add(`${best.s}:${best.c}`);
    targetSources.set(`${best.t}:${best.c}`, (targetSources.get(`${best.t}:${best.c}`) ?? 0) + 1);
    if (!stopsBySource.has(best.s)) stopsBySource.set(best.s, new Set());
    stopsBySource.get(best.s)!.add(best.t);
  }

  // explanations describe the state before this analysis' picks
  const baseSlots = buildSlots(ctx, forecasts, reservations);
  const drafts: MissionDraft[] = [];
  for (const [s, targets] of stopsBySource) {
    const cands = chosen.filter((x) => x.s === s);
    const ordered = orderStops(ctx, s, [...targets]);
    const lines: MissionLine[] = [];
    const stops: MissionStop[] = [];
    const effect: ExplanationLine[] = [];
    const allLines = cands.map((x) => ({ c: x.c, qty: x.qty }));
    for (const [oi, { t, leg }] of ordered.entries()) {
      const stopCands = cands.filter((x) => x.t === t).sort((a, b) => b.priority - a.priority);
      lines.push(...stopCands.map((cnd) => explainLine(ctx, pm, forecasts, baseSlots, pairStats, cnd)));
      stops.push({ targetFridgeId: ctx.snap.fridges[t].id, travelMinutes: leg, deliveredAt: null });
      effect.push(...effectOf(ctx, forecasts, s, t, stopCands.map((x) => ({ c: x.c, qty: x.qty })), oi === 0 ? allLines : null));
    }
    const priority = Math.max(...cands.map((x) => x.priority));
    const lead = cands.reduce((a, b) => (b.priority > a.priority ? b : a));
    const tf = forecasts[lead.t].categories[lead.c];
    const catId = ctx.snap.categories[lead.c].id;
    let type: MissionType = "REBALANCE";
    if (tf.state === "EMPTY_RISK" && (tf.minutesToEmpty ?? 999) <= 120) type = "URGENT";
    else if (priority >= ENGINE_CONFIG.priority.labels.critical) type = "URGENT";
    else if (lead.rescue) type = "RESCUE";
    const title = type === "URGENT" ? "URGENT" : type === "RESCUE" ? `${CAT_EN[catId]} RESCUE` : ordered.length > 1 ? "ROUTE" : "REBALANCE";
    const tgtF = ctx.snap.fridges[lead.t];
    const srcF = ctx.snap.fridges[s];
    const headline =
      type === "RESCUE"
        ? `${srcF.name}: излишек ${CAT_GEN[catId]} ≈ ${baseSlots[s][lead.c].surplus} шт.${forecasts[s].categories[lead.c].wasteUnits >= 1 ? ", иначе спишем" : ""}`
        : tf.minutesToEmpty === 0
          ? `${tgtF.name} уже без ${CAT_GEN[catId]} — спрос есть`
          : tf.minutesToEmpty !== null
            ? `${tgtF.name} может остаться без ${CAT_GEN[catId]} через ${fmtDuration(tf.minutesToEmpty)}`
            : `${tgtF.name} продаст больше ${CAT_GEN[catId]}, чем у него есть`;
    drafts.push({
      type,
      title,
      priority,
      priorityLabel: priorityLabel(priority),
      urgency: type === "URGENT" ? "NOW" : urgencyOf(priority, tf.minutesToEmpty),
      sourceFridgeId: srcF.id,
      targetFridgeId: stops[0].targetFridgeId,
      stops,
      travelMinutes: stops.reduce((a, x) => a + x.travelMinutes, 0),
      lines,
      headline,
      effect: effect.slice(0, 4),
    });
  }
  return drafts.sort((a, b) => b.priority - a.priority);
}
