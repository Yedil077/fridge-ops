import { ENGINE_CONFIG } from "../config/engine";
import { QUARTERS, type CategoryForecast, type FridgeForecast } from "../domain/types";
import { activityProfile, activityWindow } from "./activity";
import { baselineFor, monthPhaseFactor, openProbability, trendFactor, typicalDay, type EngineContext } from "./history";
import { classify, fridgeHealth, fridgeStatus, safetyStock, wasteUnits } from "./risk";

/**
 * Forecast hierarchy:
 *  1. today's live demand (pace)  2. same weekdays  3. last 30 d  4. 90 d  5. 180 d  6. network (cold start)
 * Levels 2–6 are blended inside `baselineFor` via recency buckets and shrinkage; level 1 is applied here.
 */

/**
 * Sum over [fromMin, toMin) where minutes count from TODAY's 00:00 and may exceed 1440:
 * the part after midnight is taken from tomorrow's curve (REAL TIME at 23:20 → 23:20–00:50).
 */
export function sumAcross(today: number[], tomorrow: number[], fromMin: number, toMin: number): number {
  if (toMin <= fromMin) return 0;
  return sumWindow(today, fromMin, Math.min(toMin, 1440)) + (toMin > 1440 ? sumWindow(tomorrow, Math.max(0, fromMin - 1440), toMin - 1440) : 0);
}

/** Hourly rate at minute m counted from today's 00:00 (m ≥ 1440 → tomorrow). */
export function rateAt(today: number[], tomorrow: number[], m: number): number {
  return m < 1440 ? today[Math.floor(m / 60)] : (tomorrow[Math.floor((m - 1440) / 60)] ?? 0);
}

/** Sum of hourly values over [fromMin, toMin) within one calendar day, with fractional hours. */
export function sumWindow(hourly: number[], fromMin: number, toMin: number): number {
  if (toMin <= fromMin) return 0;
  let s = 0;
  for (let h = Math.floor(fromMin / 60); h < Math.min(24, Math.ceil(toMin / 60)); h++) {
    const overlap = Math.max(0, Math.min(toMin, h * 60 + 60) - Math.max(fromMin, h * 60)) / 60;
    s += hourly[h] * overlap;
  }
  return s;
}

function interval(expected: number, cv: number, confidence: number): [number, number] {
  const widen = 1 + (1 - confidence) * 0.8;
  const sd = Math.sqrt(expected + 0.5 * (cv * expected) ** 2) * widen;
  return [Math.max(0, Math.floor(expected - sd)), Math.ceil(expected + sd)];
}

function shrinkPace(actual: number, expected: number, toward = 1): number {
  if (expected <= 0) return toward;
  const raw = actual / expected;
  const w = expected / (expected + ENGINE_CONFIG.pace.strength);
  return toward + w * (raw - toward);
}

export function forecastFridge(ctx: EngineContext, f: number): FridgeForecast {
  const { snap, C, today, nowMinute } = ctx;
  const cfgPace = ENGINE_CONFIG.pace;
  const qNow = Math.floor(nowMinute / 15);
  const monthF = monthPhaseFactor(ctx, f);
  const monthTomorrow = monthPhaseFactor(ctx, f, today + 1);
  // learned P(the fridge sells today / tomorrow) — the configured schedule is only a weak prior
  const pToday = openProbability(ctx, f, today);
  const pTomorrow = openProbability(ctx, f, today + 1);
  let soldToday = 0;
  for (let i = f * C * QUARTERS; i < (f + 1) * C * QUARTERS; i++) soldToday += snap.today.quarterSales[i];
  let soldLastHour = 0;
  for (let c = 0; c < C; c++)
    for (let q = Math.max(0, qNow - 4); q < qNow; q++) soldLastHour += snap.today.quarterSales[(f * C + c) * QUARTERS + q];
  // a day with sales is an open day: use the open-day curve; otherwise weight it by P(open)
  const todayFactor = soldToday > 0 ? 1 : pToday;
  const workingToday = soldToday > 0 || pToday >= 0.5;
  const workingTomorrow = pTomorrow >= 0.5;
  const activity = activityWindow(activityProfile(ctx, f), today, nowMinute);
  const isOpenNow = activity.activeNow || soldLastHour > 0;
  const activityEnd = isOpenNow && !activity.activeNow ? Math.max(activity.end, nowMinute + 60) : activity.end;
  const minutesToClose = isOpenNow ? Math.max(0, activityEnd - nowMinute) : 0;
  const minutesToOpen = !isOpenNow && activity.nextStart !== null ? activity.nextStart - nowMinute : null;

  // pass 1: normal curve and pace inputs per category
  const pre = [];
  let fridgeExpected = 0;
  let fridgeActual = 0;
  let salesToday = 0;
  for (let c = 0; c < C; c++) {
    const base = baselineFor(ctx, f, c);
    const tf = trendFactor(ctx, f, c);
    const bias = ctx.bias(f, c);
    const normalHourly = base.hourly.map((v) => v * todayFactor * tf * monthF * bias);
    const baseTomorrow = baselineFor(ctx, f, c, today + 1);
    const normalTomorrow = baseTomorrow.hourly.map((v) => v * pTomorrow * tf * monthTomorrow * bias);
    let expSoFar = 0;
    let actSoFar = 0;
    let catSales = 0;
    let lastHour = 0;
    let last2h = 0;
    for (let q = 0; q < QUARTERS; q++) {
      const idx = (f * C + c) * QUARTERS + q;
      const sold = snap.today.quarterSales[idx];
      catSales += sold;
      if (q >= qNow - 4 && q < qNow) lastHour += sold;
      if (q >= qNow - 8 && q < qNow) last2h += sold;
      if (q >= qNow) continue;
      if (snap.today.stockoutQuarters[idx]) continue; // censored demand — don't learn from empty shelves
      expSoFar += normalHourly[Math.floor(q / 4)] / 4;
      actSoFar += sold;
    }
    fridgeExpected += expSoFar;
    fridgeActual += actSoFar;
    salesToday += catSales;
    pre.push({ base, tf, bias, normalHourly, normalTomorrow, expSoFar, actSoFar, catSales, lastHour, last2h });
  }

  const fridgePace = Math.min(cfgPace.max, Math.max(cfgPace.min, shrinkPace(fridgeActual, fridgeExpected)));
  const typical = typicalDay(ctx, f);
  const categories: CategoryForecast[] = [];
  const riskEnd = nowMinute + ENGINE_CONFIG.riskHorizonMinutes;
  let restOfCalendarDay = 0;

  for (let c = 0; c < C; c++) {
    const p = pre[c];
    const cat = snap.categories[c];
    const catPace = Math.min(cfgPace.max, Math.max(cfgPace.min, fridgePace * shrinkPace(p.actSoFar, p.expSoFar * fridgePace)));
    const effect = 1 + cfgPace.weight * (catPace - 1);
    const forecastHourly = p.normalHourly.map((v) => v * effect);
    // today's pace says something about tomorrow too, but less
    const tomorrowHourly = p.normalTomorrow.map((v) => v * (1 + 0.5 * (effect - 1)));
    let stock = 0;
    for (const pi of ctx.catProducts[c]) stock += snap.stock[f * ctx.P + pi];

    // windows always start NOW and may cross midnight; the activity curve itself is ~0 where nobody buys
    const e1 = sumAcross(forecastHourly, tomorrowHourly, nowMinute, nowMinute + 60);
    const e2 = sumAcross(forecastHourly, tomorrowHourly, nowMinute, riskEnd);
    const eClose = sumAcross(forecastHourly, tomorrowHourly, nowMinute, activityEnd);
    restOfCalendarDay += sumWindow(forecastHourly, nowMinute, 1440);

    // confidence
    const hc = ENGINE_CONFIG.history;
    const dataScore = Math.min(1, p.base.nSameWeekday / hc.fullConfidenceSamples) ** 0.6;
    const stability = 1 - Math.min(0.6, p.base.cv);
    const paceDev = 1 - Math.min(0.4, 0.6 * Math.abs(catPace - 1));
    const confidence = Math.min(0.97, Math.max(0.2, 0.15 + 0.85 * dataScore * stability * paceDev));

    // time to empty at forecast rate
    let minutesToEmpty: number | null = null;
    const emptyHorizon = Math.max(activityEnd, riskEnd);
    if (isOpenNow || activityEnd > nowMinute) {
      if (stock <= 0) minutesToEmpty = 0;
      else {
        let cum = 0;
        for (let m = nowMinute; m < emptyHorizon; m += 5) {
          cum += rateAt(forecastHourly, tomorrowHourly, m) / 12;
          if (cum >= stock) {
            minutesToEmpty = m + 5 - nowMinute;
            break;
          }
        }
      }
    }

    const safety = safetyStock(e1);
    const waste = isOpenNow || workingToday ? wasteUnits(cat, stock, eClose, workingTomorrow) : 0;
    const windowMinutes = 60;
    const partial = {
      stock,
      expected2h: e2,
      expectedUntilClose: eClose,
      projected2h: stock - e2,
      safetyStock: safety,
      wasteUnits: waste,
    };
    categories.push({
      fridgeIndex: f,
      categoryIndex: c,
      stock,
      normalHourly: p.normalHourly,
      forecastHourly,
      tomorrowHourly,
      salesToday: p.catSales,
      salesLastHour: p.lastHour,
      salesLast2h: p.last2h,
      velocity: (e1 / windowMinutes) * 60,
      expected1h: e1,
      expected2h: e2,
      expectedUntilClose: eClose,
      interval1h: interval(e1, p.base.cv, confidence),
      interval2h: interval(e2, p.base.cv, confidence),
      intervalClose: interval(eClose, p.base.cv, confidence),
      pace: catPace,
      rawPace: p.expSoFar > 0 ? p.actSoFar / p.expSoFar : 1,
      expectedSoFar: p.expSoFar,
      actualSoFar: p.actSoFar,
      confidence,
      cv: p.base.cv,
      trendFactor: p.tf,
      monthFactor: monthF,
      bias: p.bias,
      baseline: {
        label: p.base.label,
        sameWeekdaySamples: p.base.nSameWeekday,
        dayTypeSamples: p.base.nDayType,
        networkWeight: p.base.networkWeight,
      },
      minutesToEmpty,
      projected1h: stock - e1,
      projected2h: stock - e2,
      projectedClose: stock - eClose,
      safetyStock: safety,
      wasteUnits: waste,
      state: isOpenNow ? classify(partial) : "CLOSED",
    });
  }

  // anomaly: projected CALENDAR day (00:00–24:00, night hours included) far outside the historical range
  const projectedDayTotal = salesToday + restOfCalendarDay;
  const an = ENGINE_CONFIG.anomaly;
  let anomaly: FridgeForecast["anomaly"] = null;
  if (workingToday && typical.n >= 4 && fridgeExpected >= an.minExpectedSoFar) {
    const rawPace = fridgeActual / Math.max(1, fridgeExpected);
    if (projectedDayTotal > typical.mean + an.sigma * typical.std && rawPace > an.paceUp)
      anomaly = { direction: "up", deviationPct: Math.round((projectedDayTotal / typical.mean - 1) * 100) };
    else if (projectedDayTotal < typical.mean - an.sigma * typical.std && rawPace < an.paceDown)
      anomaly = { direction: "down", deviationPct: Math.round((projectedDayTotal / typical.mean - 1) * 100) };
  }
  if (anomaly) for (const c of categories) c.confidence = Math.max(0.2, c.confidence * an.confidencePenalty);

  const weights = categories.map((c) => c.normalHourly.reduce((a, b) => a + b, 0));
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  const confidence = categories.reduce((a, c, i) => a + c.confidence * (weights[i] / wsum), 0);

  return {
    fridgeIndex: f,
    isOpenNow,
    isWorkingToday: workingToday,
    isWorkingTomorrow: workingTomorrow,
    minutesToClose,
    minutesToOpen,
    activityEndMinute: activityEnd,
    salesToday,
    revenueToday: snap.today.revenue[f] ?? 0,
    pace: fridgePace,
    expectedSoFar: fridgeExpected,
    projectedDayTotal,
    typicalDayTotal: typical.mean,
    typicalDayStd: typical.std,
    anomaly,
    categories,
    totalStock: categories.reduce((a, c) => a + c.stock, 0),
    status: fridgeStatus(isOpenNow, categories, snap.categories, !!anomaly),
    health: isOpenNow ? fridgeHealth(categories, weights) : 1,
    confidence,
  };
}
