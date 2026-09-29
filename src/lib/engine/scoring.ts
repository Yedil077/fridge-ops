import { ENGINE_CONFIG } from "../config/engine";
import { QUARTERS, type FridgeForecast, type Mission, type NetworkSnapshot } from "../domain/types";
import { dayNumber } from "../time";

/** Daily score & network KPIs shown on the command center. */

export interface DailyScore {
  total: number;
  availability: number;
  wasteRisk: number;
  balance: number;
  completedMissions: number;
  savedProducts: number;
  missionRate: number;
}

export function dailyScore(snap: NetworkSnapshot, forecasts: FridgeForecast[], missions: Mission[]): DailyScore {
  const { fridges, categories, today } = snap;
  const C = categories.length;
  const qNow = Math.floor((snap.now / 60000 - today.day * 1440) / 15);

  // availability: share of open quarter-hours with the category in stock (core categories with demand)
  let slots = 0;
  let empty = 0;
  forecasts.forEach((ff, f) => {
    if (!ff.isWorkingToday) return;
    const fr = fridges[f];
    const q0 = Math.ceil(fr.openingMinute / 15);
    const q1 = Math.min(qNow, Math.floor(fr.closingMinute / 15));
    ff.categories.forEach((cf, c) => {
      if (!categories[c].core) return;
      if (cf.normalHourly.reduce((a, b) => a + b, 0) < 1) return;
      for (let q = q0; q < q1; q++) {
        slots++;
        if (today.stockoutQuarters[(f * C + c) * QUARTERS + q]) empty++;
      }
    });
  });
  const availability = slots ? 1 - empty / slots : 1;

  // waste risk: projected write-offs / perishable stock
  let waste = 0;
  let perishable = 0;
  // balance: demand-weighted share of NORMAL categories
  let bal = 0;
  let balW = 0;
  const S = ENGINE_CONFIG.score;
  forecasts.forEach((ff) => {
    if (!ff.isWorkingToday) return;
    ff.categories.forEach((cf, c) => {
      if (categories[c].wasteShare[1] > 0) {
        waste += cf.wasteUnits;
        perishable += cf.stock;
      }
      if (!ff.isOpenNow) return;
      const w = cf.expectedUntilClose + 0.5;
      balW += w;
      const cover = cf.stock / Math.max(1, cf.expectedUntilClose);
      const ok = cf.state === "NORMAL" || (cover >= S.balanceLow && cover <= S.balanceHigh && cf.state !== "EMPTY_RISK");
      if (ok) bal += w;
    });
  });
  const wasteRisk = perishable ? waste / perishable : 0;
  const balance = balW ? bal / balW : 1;

  const todays = missions.filter((m) => dayNumber(m.createdAt) === today.day);
  const completed = todays.filter((m) => m.status === "COMPLETED");
  // EXPIRED missions were replaced by a newer analysis — not a failure of the team, so they don't count
  const closed = todays.filter((m) => m.status === "COMPLETED" || m.status === "SKIPPED");
  const missionRate = closed.length ? completed.length / closed.length : 1;
  const savedProducts = completed.reduce(
    (a, m) => a + (m.evaluation ? m.evaluation.lines.reduce((x, l) => x + l.soldAttributed, 0) : 0),
    0,
  );

  const W = S.weights;
  const total = Math.round(
    100 * (W.availability * availability + W.waste * (1 - Math.min(1, wasteRisk * 2)) + W.balance * balance + W.missions * missionRate),
  );
  return { total, availability, wasteRisk, balance, completedMissions: completed.length, savedProducts, missionRate };
}

// ───────────────────────── XP & levels ─────────────────────────

const LEVEL_TITLES = ["Trainee", "Dispatcher", "Senior Dispatcher", "Logistics Lead", "Ops Commander", "Network Master"];

/** Level k starts at 150·k·(k−1) XP: 0, 300, 900, 1800, 3000 … */
export function levelInfo(xp: number) {
  let level = 1;
  while (150 * (level + 1) * level <= xp) level++;
  const from = 150 * level * (level - 1);
  const to = 150 * (level + 1) * level;
  return {
    level,
    title: LEVEL_TITLES[Math.min(LEVEL_TITLES.length - 1, level - 1)],
    xp,
    levelFrom: from,
    levelTo: to,
    progress: (xp - from) / (to - from),
  };
}
