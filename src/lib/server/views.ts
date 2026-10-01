import "server-only";
import { CATEGORIES } from "../domain/categories";
import { QUARTERS, type ForecastMode, type FridgeForecast, type Mission, type NetworkSnapshot, type RiskState } from "../domain/types";
import { personalities, type AnalysisResult } from "../engine/analysis";
import { histDay, type EngineContext } from "../engine/history";
import { activityProfile, fmtHourWindow, fmtRange, type ActivityProfile } from "../engine/activity";
import type { Fridge } from "../domain/types";
import { dailyScore, levelInfo } from "../engine/scoring";
import { dayNumber, fmtDuration, fmtHM, isoDate, minuteOfDay, weekdayOf, weekdayPlural } from "../time";
import type { AppState } from "../store/appStore";

/** View models: what the UI needs, nothing more. The UI never sees raw engine internals it cannot explain. */

const WD_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Configured schedule as text; closing before opening = continues after midnight. */
export function scheduleText(fr: Fridge): string {
  const days = fr.workingDays.length === 7 ? "ежедневно" : fr.workingDays.map((d) => WD_SHORT[d - 1]).join(" ");
  return `${days} ${fmtHM(fr.openingMinute)}–${fmtHM(fr.closingMinute)}${fr.closingMinute < fr.openingMinute ? " (через полночь)" : ""}`;
}

/** Observed activity of one fridge for the UI (learned from real sale timestamps, all hours, all weekdays). */
export function activitySummary(p: ActivityProfile, fr: Fridge) {
  return {
    configured: scheduleText(fr),
    ranges: p.ranges.map(fmtRange),
    learnedWeekdays: p.learned.filter(Boolean).length,
    nightShare: r1(p.nightShare * 100),
    weekendShare: r1(p.weekendShare * 100),
    peaks: p.peaks.map((x) => fmtHourWindow(x.from, x.to)),
    topHours: p.topHours.map((h) => fmtHourWindow(h, h + 1)),
    mismatches: p.mismatches.map((m) => ({ weekday: WD_SHORT[m.weekday - 1], hours: hoursText(m.hours) })),
    /** [weekday][hour] average units per day */
    heatmap: p.avg.map((row) => row.map(r1)),
  };
}

/** [3,4,5,9] → "03:00–06:00, 09:00–10:00" */
function hoursText(hours: number[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < hours.length) {
    let j = i;
    while (j + 1 < hours.length && hours[j + 1] === hours[j] + 1) j++;
    out.push(fmtHourWindow(hours[i], hours[j] + 1));
    i = j + 1;
  }
  return out.join(", ");
}

const CAT_GEN: Record<string, string> = {
  breakfast: "завтраки", hot: "горячее", salad: "салаты", snack: "перекусы", dessert: "десерты", drink: "напитки",
};

function forecastNote(ff: FridgeForecast): string | null {
  if (!ff.isOpenNow) return null;
  const soon = ff.categories
    .filter((c) => CATEGORIES[c.categoryIndex].core && c.minutesToEmpty !== null && c.expected2h >= 1)
    .sort((a, b) => (a.minutesToEmpty ?? 0) - (b.minutesToEmpty ?? 0))[0];
  if (soon && soon.minutesToEmpty !== null && soon.minutesToEmpty <= 180) {
    const cat = CATEGORIES[soon.categoryIndex];
    return soon.minutesToEmpty === 0
      ? `${cat.emoji} ${CAT_GEN[cat.id]} закончились`
      : `через ${fmtDuration(soon.minutesToEmpty)} могут закончиться ${CAT_GEN[cat.id]}`;
  }
  const waste = ff.categories.filter((c) => c.wasteUnits >= 3).sort((a, b) => b.wasteUnits - a.wasteUnits)[0];
  if (waste) {
    const cat = CATEGORIES[waste.categoryIndex];
    return `${cat.emoji} риск списания ~${Math.round(waste.wasteUnits)} шт. ${CAT_GEN[cat.id]}`;
  }
  return null;
}

export function playerView(state: AppState, user: string) {
  const p = state.players[user] ?? { name: user, xp: 0, points: 0, streak: 0, bestStreak: 0 };
  return { name: p.name, points: p.points, streak: p.streak, bestStreak: p.bestStreak, ...levelInfo(p.xp) };
}

/** Attaches current display names to missions (fridges can be renamed in Admin). */
export function withNames(missions: Mission[], names: Record<string, string>): Mission[] {
  return missions.map((m) => ({
    ...m,
    sourceName: names[m.sourceFridgeId] ?? m.sourceFridgeId,
    stopNames: Object.fromEntries((m.stops ?? []).map((s) => [s.targetFridgeId, names[s.targetFridgeId] ?? s.targetFridgeId])),
  }));
}

/** NEW missions of the chosen mode + every mission already taken (a started route never disappears). */
export const inMode = (m: Mission, mode: ForecastMode) =>
  m.status === "ACCEPTED" || m.status === "IN_PROGRESS" || (m.status === "NEW" && (m.mode ?? "realtime") === mode);

export function missionsView(state: AppState, day: number, names: Record<string, string> = {}, mode: ForecastMode = "realtime") {
  const open = state.missions
    .filter((m) => inMode(m, mode))
    .sort((a, b) => b.priority - a.priority);
  const recent = state.missions
    .filter((m) => (m.status === "COMPLETED" || m.status === "SKIPPED") && dayNumber(m.createdAt) === day)
    .sort((a, b) => (b.completedAt ?? b.skippedAt ?? 0) - (a.completedAt ?? a.skippedAt ?? 0))
    .slice(0, 8);
  return { open: withNames(open, names), recent: withNames(recent, names) };
}

const namesOf = (snap: NetworkSnapshot) => Object.fromEntries(snap.fridges.map((f) => [f.id, f.name]));

export function dashboardView(snap: NetworkSnapshot, a: AnalysisResult, state: AppState, user: string, mode: string, forecastMode: ForecastMode = "realtime") {
  const { forecasts } = a;
  const personas = personalities(a.ctx, a.demandIndex);
  const score = dailyScore(snap, forecasts, state.missions);
  const online = forecasts.filter((f) => f.isOpenNow).length;
  const salesToday = forecasts.reduce((x, f) => x + f.salesToday, 0);
  const revenueToday = forecasts.reduce((x, f) => x + f.revenueToday, 0);
  const expected = forecasts.reduce((x, f) => x + f.expectedSoFar, 0);
  const actual = forecasts.reduce((x, f) => x + f.categories.reduce((y, c) => y + c.actualSoFar, 0), 0);
  const openF = forecasts.filter((f) => f.isOpenNow);
  const health = openF.length ? openF.reduce((x, f) => x + f.health, 0) / openF.length : 1;
  const m = minuteOfDay(snap.now);
  const greeting = m < 12 * 60 ? "Доброе утро" : m < 18 * 60 ? "Добрый день" : "Добрый вечер";
  const missions = missionsView(state, snap.today.day, namesOf(snap), forecastMode);

  return {
    now: snap.now,
    mode,
    forecastMode,
    greeting,
    network: {
      fridgesTotal: snap.fridges.length,
      fridgesOnline: online,
      salesToday,
      revenueToday: Math.round(revenueToday),
      vsTypicalPct: expected > 3 ? Math.round((actual / expected - 1) * 100) : null,
      health,
      critical: forecasts.filter((f) => f.status === "critical").length,
      attention: forecasts.filter((f) => f.status === "attention").length,
      missionsOpen: missions.open.length,
    },
    score,
    player: playerView(state, user),
    missions,
    lastAnalysisAt: state.lastAnalysisAt,
    fridges: forecasts.map((ff) => {
      const fr = snap.fridges[ff.fridgeIndex];
      const persona = personas[ff.fridgeIndex];
      const typicalSoFar = ff.expectedSoFar;
      return {
        id: fr.id,
        code: fr.code,
        name: fr.name,
        location: fr.location,
        status: ff.status,
        isOpenNow: ff.isOpenNow,
        isWorkingToday: ff.isWorkingToday,
        // observed activity (learned), not the configured schedule
        opensAt: ff.minutesToOpen !== null ? fmtHM(minuteOfDay(snap.now) + ff.minutesToOpen) : null,
        closesAt: ff.isOpenNow ? fmtHM(ff.activityEndMinute) : null,
        fillPct: Math.min(100, Math.round((ff.totalStock / fr.capacity) * 100)),
        totalStock: ff.totalStock,
        salesToday: ff.salesToday,
        trendPct: typicalSoFar > 3 ? Math.round((ff.categories.reduce((x, c) => x + c.actualSoFar, 0) / typicalSoFar - 1) * 100) : null,
        forecastNote: forecastNote(ff),
        anomaly: ff.anomaly,
        health: ff.health,
        profile: { title: persona.title, emoji: persona.emoji },
        categories: ff.categories.map((c) => ({
          id: CATEGORIES[c.categoryIndex].id,
          emoji: CATEGORIES[c.categoryIndex].emoji,
          name: CATEGORIES[c.categoryIndex].name,
          stock: c.stock,
          state: c.state as RiskState,
        })),
      };
    }),
  };
}

export type DashboardView = ReturnType<typeof dashboardView>;

export function fridgeDetailView(snap: NetworkSnapshot, a: AnalysisResult, fridgeId: string, state: AppState) {
  const f = snap.fridges.findIndex((x) => x.id === fridgeId);
  if (f < 0) return null;
  const fr = snap.fridges[f];
  const ff = a.forecasts[f];
  const persona = personalities(a.ctx, a.demandIndex)[f];
  const C = CATEGORIES.length;
  const hourlyToday = new Array<number>(24).fill(0);
  for (let c = 0; c < C; c++)
    for (let q = 0; q < QUARTERS; q++) hourlyToday[Math.floor(q / 4)] += snap.today.quarterSales[(f * C + c) * QUARTERS + q];
  const typicalHourly = new Array<number>(24).fill(0);
  const forecastHourly = new Array<number>(24).fill(0);
  ff.categories.forEach((c) => c.normalHourly.forEach((v, h) => { typicalHourly[h] += v; forecastHourly[h] += c.forecastHourly[h]; }));
  const nowH = Math.floor(minuteOfDay(snap.now) / 60);
  const activity = activitySummary(activityProfile(a.ctx, f), fr);

  return {
    now: snap.now,
    fridge: {
      id: fr.id, code: fr.code, name: fr.name, location: fr.location, locationType: fr.locationType,
      workingDays: fr.workingDays, opening: fmtHM(fr.openingMinute), closing: fmtHM(fr.closingMinute), capacity: fr.capacity,
    },
    activity,
    activeUntil: ff.isOpenNow ? fmtHM(ff.activityEndMinute) : null,
    status: ff.status,
    isOpenNow: ff.isOpenNow,
    isWorkingTomorrow: ff.isWorkingTomorrow,
    salesToday: ff.salesToday,
    revenueToday: Math.round(ff.revenueToday),
    pace: ff.pace,
    typicalDayTotal: Math.round(ff.typicalDayTotal),
    projectedDayTotal: Math.round(ff.projectedDayTotal),
    anomaly: ff.anomaly,
    confidence: ff.confidence,
    persona: {
      ...persona,
      topProducts: persona.topProducts.map((p) => ({ name: snap.products[p.productIndex].name, perDay: p.perDay })),
      weakProducts: persona.weakProducts.map((p) => ({ name: snap.products[p.productIndex].name, perDay: p.perDay })),
    },
    categories: ff.categories.map((c) => ({
      id: CATEGORIES[c.categoryIndex].id,
      emoji: CATEGORIES[c.categoryIndex].emoji,
      name: CATEGORIES[c.categoryIndex].name,
      stock: c.stock,
      state: c.state,
      salesToday: c.salesToday,
      velocity: c.velocity,
      expected1h: c.expected1h,
      expected2h: c.expected2h,
      expectedUntilClose: c.expectedUntilClose,
      interval2h: c.interval2h,
      intervalClose: c.intervalClose,
      pace: c.pace,
      confidence: c.confidence,
      minutesToEmpty: c.minutesToEmpty,
      safetyStock: c.safetyStock,
      wasteUnits: c.wasteUnits,
      baseline: c.baseline,
      trendFactor: c.trendFactor,
      bias: c.bias,
    })),
    hourly: Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      label: `${String(h).padStart(2, "0")}:00`,
      today: h < nowH || (h === nowH && hourlyToday[h] > 0) ? hourlyToday[h] : null,
      typical: Math.round(typicalHourly[h] * 10) / 10,
      forecast: h >= nowH ? Math.round(forecastHourly[h] * 10) / 10 : null,
    })), // 00–23, nothing hidden
    missions: withNames(
      state.missions
        .filter((m) => m.sourceFridgeId === fr.id || (m.stops ?? []).some((s) => s.targetFridgeId === fr.id))
        .slice(-10)
        .reverse(),
      namesOf(snap),
    ),
  };
}

// ───────────────────────── analytics ─────────────────────────

export function analyticsView(snap: NetworkSnapshot, a: AnalysisResult, state: AppState) {
  const { ctx } = a;
  const C = CATEGORIES.length;
  const todayWd = weekdayOf(ctx.today);

  // sales by fridge: today vs typical so far, last 7 days avg
  const byFridge = a.forecasts.map((ff) => {
    const fr = snap.fridges[ff.fridgeIndex];
    let s7 = 0;
    let n7 = 0;
    for (let d = ctx.D - 7; d < ctx.D; d++) if (ctx.sample[ff.fridgeIndex * ctx.D + d]) { s7 += ctx.fridgeDay[ff.fridgeIndex * ctx.D + d]; n7++; }
    return { id: fr.id, name: fr.shortName, today: ff.salesToday, typicalSoFar: Math.round(ff.expectedSoFar), avg7: n7 ? Math.round(s7 / n7) : 0 };
  });

  const byCategory = CATEGORIES.map((cat, c) => {
    let today = 0;
    let d30 = 0;
    for (let f = 0; f < ctx.F; f++) {
      for (let q = 0; q < QUARTERS; q++) today += snap.today.quarterSales[(f * C + c) * QUARTERS + q];
      for (let d = ctx.D - 30; d < ctx.D; d++) d30 += ctx.catDay[(f * C + c) * ctx.D + d];
    }
    return { id: cat.id, name: cat.name, emoji: cat.emoji, today, avgPerDay30: Math.round(d30 / 30) };
  });

  // network hourly: today vs typical same weekday
  const nowMin = minuteOfDay(snap.now);
  const hourly = Array.from({ length: 24 }, (_, h) => {
    let today = 0;
    let typical = 0;
    for (let f = 0; f < ctx.F; f++) {
      for (let c = 0; c < C; c++) {
        for (let q = h * 4; q < h * 4 + 4; q++) today += snap.today.quarterSales[(f * C + c) * QUARTERS + q];
        typical += a.forecasts[f].categories[c].normalHourly[h];
      }
    }
    return { hour: h, label: `${String(h).padStart(2, "0")}:00`, today: h * 60 < nowMin ? today : null, typical: Math.round(typical * 10) / 10 };
  }); // 00–23: night hours are shown, not filtered
  const salesSoFar = hourly.reduce((x, r) => x + (r.today ?? 0), 0);
  const typicalSoFar = Math.round(a.forecasts.reduce((x, f) => x + f.expectedSoFar, 0));

  // weekday demand (network, last 90 days)
  const wdSum = new Array<number>(7).fill(0);
  const wdDays = new Array<number>(7).fill(0);
  for (let d = Math.max(0, ctx.D - 90); d < ctx.D; d++) {
    const wd = weekdayOf(histDay(ctx, d)) - 1;
    let tot = 0;
    for (let f = 0; f < ctx.F; f++) tot += ctx.fridgeDay[f * ctx.D + d];
    wdSum[wd] += tot;
    wdDays[wd]++;
  }
  const weekday = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((name, i) => ({ name, avg: wdDays[i] ? Math.round(wdSum[i] / wdDays[i]) : 0 }));

  // TIME: sales by hour 0–23 and weekday × hour (network, average per calendar day, last 90 days), per fridge activity
  const profiles = snap.fridges.map((_, f) => activityProfile(ctx, f));
  const salesByHour = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    label: `${String(h).padStart(2, "0")}:00`,
    avg: r1(profiles.reduce((x, p) => x + p.hourly[h], 0)),
  }));
  const weekHour = Array.from({ length: 7 }, (_, w) =>
    Array.from({ length: 24 }, (_, h) => r1(profiles.reduce((x, p) => x + p.avg[w][h], 0))),
  );
  const timeByFridge = snap.fridges.map((fr, f) => ({ id: fr.id, name: fr.name, ...activitySummary(profiles[f], fr) }));
  const networkUnits = profiles.reduce((x, p) => x + p.totalUnits, 0) || 1;
  const time = {
    salesByHour,
    weekHour,
    weekdays: WD_SHORT,
    nightShare: r1((profiles.reduce((x, p) => x + p.nightShare * p.totalUnits, 0) / networkUnits) * 100),
    weekendShare: r1((profiles.reduce((x, p) => x + p.weekendShare * p.totalUnits, 0) / networkUnits) * 100),
    fridges: timeByFridge,
  };

  // heatmap: demand index fridge × category
  const heatmap = a.demandIndex.map((row) => ({
    id: snap.fridges[row.fridgeIndex].id,
    name: snap.fridges[row.fridgeIndex].name,
    index: row.index.map((v) => Math.round(v * 100) / 100),
    share: row.share.map((v) => Math.round(v * 1000) / 10),
  }));

  // mission effectiveness
  const done = state.missions.filter((m) => m.status === "COMPLETED");
  const evaluated = done.filter((m) => m.evaluation);
  const moved = evaluated.reduce((x, m) => x + m.evaluation!.lines.reduce((y, l) => y + l.moved, 0), 0);
  const sold = evaluated.reduce((x, m) => x + m.evaluation!.lines.reduce((y, l) => y + l.soldAttributed, 0), 0);
  const accuracy = evaluated.length ? evaluated.reduce((x, m) => x + m.evaluation!.accuracy, 0) / evaluated.length : null;
  const results = { EXCELLENT: 0, GOOD: 0, WEAK: 0, POOR: 0 };
  for (const m of evaluated) results[m.evaluation!.result]++;
  const names = namesOf(snap);
  const pairs = Object.entries(state.learning.pairStats)
    .map(([key, v]) => {
      const [route, cat] = key.split(":");
      const [s, t] = route.split(">");
      return { route: `${names[s] ?? s} → ${names[t] ?? t}`, category: cat, ...v, rate: v.moved ? v.sold / v.moved : 0 };
    })
    .sort((x, y) => y.moved - x.moved)
    .slice(0, 12);
  const byStatus = { NEW: 0, ACCEPTED: 0, IN_PROGRESS: 0, COMPLETED: 0, SKIPPED: 0, EXPIRED: 0 } as Record<Mission["status"], number>;
  for (const m of state.missions) byStatus[m.status]++;

  // recommendation acceptance: how much of what the system recommends people really move
  const withAcc = done.filter((m) => m.acceptance !== null && m.acceptance !== undefined);
  const recTotal = withAcc.reduce((x, m) => x + m.lines.reduce((y, l) => y + l.recommendedQty, 0), 0);
  const movedTotal = withAcc.reduce((x, m) => x + m.lines.reduce((y, l) => y + (l.actualQty ?? 0), 0), 0);
  const skipReasons: Record<string, number> = {};
  for (const m of state.missions)
    for (const l of m.lines) for (const p of l.products) if (p.skipReason) skipReasons[p.skipReason] = (skipReasons[p.skipReason] ?? 0) + 1;
  const acceptance = {
    ratio: recTotal ? movedTotal / recTotal : null,
    recommended: recTotal,
    moved: movedTotal,
    bySource: Object.entries(state.learning.acceptance ?? {})
      .filter(([k]) => k !== "_all")
      .map(([id, v]) => ({ name: names[id] ?? id, ratio: v.ratio, n: v.n }))
      .sort((x, y) => x.ratio - y.ratio),
    skipReasons,
  };

  return {
    now: snap.now,
    weekdayName: weekdayPlural(todayWd),
    acceptance,
    byFridge,
    byCategory,
    hourly,
    salesSoFar,
    typicalSoFar,
    weekday,
    heatmap,
    time,
    categories: CATEGORIES.map((c) => ({ id: c.id, name: c.name, emoji: c.emoji })),
    missions: {
      byStatus,
      evaluated: evaluated.length,
      moved,
      sold,
      successRate: moved ? sold / moved : null,
      accuracy,
      results,
      pairs,
      history: withNames(done.slice(-25).reverse(), names),
    },
    wasteRisk: a.forecasts
      .filter((f) => f.isWorkingToday || f.isOpenNow)
      .map((f) => ({ name: snap.fridges[f.fridgeIndex].shortName, units: Math.round(f.categories.reduce((x, c) => x + c.wasteUnits, 0) * 10) / 10 }))
      .sort((x, y) => y.units - x.units),
  };
}

// ───────────────────────── history explorer ─────────────────────────

export interface HistoryDay {
  date: string;
  weekday: number;
  total: number;
  categories: number[];
  peakHour: number | null;
  open: number;
  holiday: boolean;
  missions: number;
  missionsCompleted: number;
  waste: number | null;
}

export function historyView(ctx: EngineContext, state: AppState, rangeDays: number, fridgeId: string | null) {
  const { snap } = ctx;
  const C = CATEGORIES.length;
  const range = Math.min(ctx.D, Math.max(7, rangeDays));
  const fIdx = fridgeId ? snap.fridges.findIndex((f) => f.id === fridgeId) : -1;
  const fridges = fIdx >= 0 ? [fIdx] : snap.fridges.map((_, i) => i);
  const d0 = ctx.D - range;

  const daily: HistoryDay[] = [];
  for (let d = d0; d < ctx.D; d++) {
    const day = histDay(ctx, d);
    const cats = new Array<number>(C).fill(0);
    for (const f of fridges) for (let c = 0; c < C; c++) cats[c] += ctx.catDay[(f * C + c) * ctx.D + d];
    const total = cats.reduce((a, b) => a + b, 0);
    let peak = 0;
    let peakVal = -1;
    for (let h = 0; h < 24; h++) {
      let v = 0;
      for (const f of fridges) for (let c = 0; c < C; c++) v += snap.history.hourly[((f * C + c) * ctx.D + d) * 24 + h];
      if (v > peakVal) { peakVal = v; peak = h; }
    }
    // fridges that really sold that day (night and weekend sales included)
    const openCount = fridges.filter((f) => ctx.sample[f * ctx.D + d]).length;
    const missions = state.missions.filter((m) => dayNumber(m.createdAt) === day && (fIdx < 0 || m.sourceFridgeId === fridgeId || m.lines.some((l) => l.targetFridgeId === fridgeId)));
    const wasteRec = state.sim?.waste.find((w) => w.day === day);
    const waste = wasteRec ? fridges.reduce((a, f) => a + wasteRec.units.slice(f * C, f * C + C).reduce((x, y) => x + y, 0), 0) : null;
    daily.push({
      date: isoDate(day),
      weekday: weekdayOf(day),
      total,
      categories: cats,
      peakHour: total > 0 ? peak : null,
      open: openCount,
      holiday: ctx.holidays.has(day),
      missions: missions.length,
      missionsCompleted: missions.filter((m) => m.status === "COMPLETED").length,
      waste,
    });
  }

  const hourlyAvg = new Array<number>(24).fill(0);
  let openDays = 0;
  for (let d = d0; d < ctx.D; d++) {
    const any = fridges.some((f) => ctx.sample[f * ctx.D + d]);
    if (!any) continue;
    openDays++;
    for (const f of fridges) for (let c = 0; c < C; c++) for (let h = 0; h < 24; h++) hourlyAvg[h] += snap.history.hourly[((f * C + c) * ctx.D + d) * 24 + h];
  }
  const hourly = hourlyAvg.map((v, h) => ({ hour: h, label: `${String(h).padStart(2, "0")}:00`, avg: openDays ? Math.round((v / openDays) * 10) / 10 : 0 })); // 00–23

  const wdSum = new Array<number>(7).fill(0);
  const wdN = new Array<number>(7).fill(0);
  daily.forEach((d) => { if (d.total > 0) { wdSum[d.weekday - 1] += d.total; wdN[d.weekday - 1]++; } });
  const weekday = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((name, i) => ({ name, avg: wdN[i] ? Math.round(wdSum[i] / wdN[i]) : 0 }));

  const catTotals = CATEGORIES.map((cat, c) => ({ id: cat.id, name: cat.name, emoji: cat.emoji, total: daily.reduce((a, d) => a + d.categories[c], 0) }));

  // demand changes: first half vs second half of the range
  const half = Math.floor(daily.length / 2);
  const changes = CATEGORIES.map((cat, c) => {
    const a1 = daily.slice(0, half).filter((d) => d.total > 0);
    const a2 = daily.slice(half).filter((d) => d.total > 0);
    const m1 = a1.length ? a1.reduce((x, d) => x + d.categories[c], 0) / a1.length : 0;
    const m2 = a2.length ? a2.reduce((x, d) => x + d.categories[c], 0) / a2.length : 0;
    return { id: cat.id, name: cat.name, emoji: cat.emoji, before: Math.round(m1 * 10) / 10, after: Math.round(m2 * 10) / 10, changePct: m1 > 0 ? Math.round((m2 / m1 - 1) * 100) : 0 };
  });

  // products
  const perProduct = snap.products.map((p, pi) => {
    let s = 0;
    for (const f of fridges) for (let d = d0; d < ctx.D; d++) s += snap.history.productDaily[(f * ctx.P + pi) * ctx.D + d];
    return { name: p.name, categoryId: p.categoryId, perDay: openDays ? Math.round((s / openDays) * 10) / 10 : 0 };
  }).sort((a, b) => b.perDay - a.perDay);

  // transfer effectiveness within range
  const startDay = histDay(ctx, d0);
  const transfers = state.missions.filter((m) => m.status === "COMPLETED" && dayNumber(m.createdAt) >= startDay && (fIdx < 0 || m.sourceFridgeId === fridgeId || m.lines.some((l) => l.targetFridgeId === fridgeId)));
  const tMoved = transfers.reduce((a, m) => a + m.lines.reduce((x, l) => x + (l.actualQty ?? l.recommendedQty), 0), 0);
  const tSold = transfers.reduce((a, m) => a + (m.evaluation?.lines.reduce((x, l) => x + l.soldAttributed, 0) ?? 0), 0);

  return {
    range,
    fridge: fIdx >= 0 ? { id: snap.fridges[fIdx].id, name: snap.fridges[fIdx].name } : null,
    fridges: snap.fridges.map((f) => ({ id: f.id, name: f.name })),
    categories: CATEGORIES.map((c) => ({ id: c.id, name: c.name, emoji: c.emoji })),
    daily,
    hourly,
    weekday,
    catTotals,
    changes,
    topProducts: perProduct.slice(0, 5),
    weakProducts: perProduct.filter((p) => p.perDay > 0).slice(-5).reverse(),
    transfers: { count: transfers.length, moved: tMoved, sold: tSold },
  };
}
