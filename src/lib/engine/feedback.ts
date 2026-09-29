import { ENGINE_CONFIG } from "../config/engine";
import { QUARTERS, type Mission, type MissionEvaluation, type NetworkSnapshot } from "../domain/types";
import { dayNumber, minuteOfDay, MINUTE_MS } from "../time";
import { pairKey, type PairStat } from "./recommend";

/**
 * Feedback loop: two hours after a transfer we check what actually sold at the target
 * and feed the result back into forecasts (bias) and route statistics (pair learning).
 */

export function isDue(m: Mission, now: number): boolean {
  return (
    m.status === "COMPLETED" &&
    !m.evaluation &&
    m.completedAt !== null &&
    now - m.completedAt >= ENGINE_CONFIG.learning.evaluationWindowMinutes * MINUTE_MS
  );
}

export function evaluateMission(m: Mission, snap: NetworkSnapshot, force = false): MissionEvaluation | null {
  if (m.status !== "COMPLETED" || m.completedAt === null || m.evaluation) return null;
  if (!force && !isDue(m, snap.now)) return null;
  if (dayNumber(m.completedAt) !== snap.today.day) return null;
  if (m.lines.every((l) => (l.actualQty ?? 0) === 0)) return null; // nothing moved — nothing to learn
  const C = snap.categories.length;
  const qStart = Math.floor(minuteOfDay(m.completedAt) / 15);
  const qEnd = Math.min(QUARTERS, qStart + ENGINE_CONFIG.learning.evaluationWindowMinutes / 15, Math.floor(minuteOfDay(snap.now) / 15));
  const lines = m.lines.map((line) => {
    const targetId = line.targetFridgeId ?? m.targetFridgeId;
    const t = Math.max(0, snap.fridges.findIndex((f) => f.id === targetId));
    const c = snap.categories.findIndex((x) => x.id === line.categoryId);
    let sales = 0;
    for (let q = qStart; q < qEnd; q++) sales += snap.today.quarterSales[(t * C + c) * QUARTERS + q];
    const moved = line.actualQty ?? line.recommendedQty;
    const soldAttributed = Math.max(0, Math.min(moved, sales - line.targetStockBefore));
    const available = line.targetStockBefore + moved;
    const predicted = Math.min(line.predictedTargetSales2h, available);
    const accuracy = Math.max(0, 1 - Math.abs(sales - predicted) / Math.max(predicted, 1));
    return {
      categoryId: line.categoryId,
      targetFridgeId: targetId,
      moved,
      salesInWindow: sales,
      soldAttributed,
      predicted: Math.round(predicted * 10) / 10,
      successRate: moved > 0 ? soldAttributed / moved : 0,
      accuracy,
    };
  });
  const moved = lines.reduce((a, l) => a + l.moved, 0);
  const sold = lines.reduce((a, l) => a + l.soldAttributed, 0);
  const successRate = moved > 0 ? sold / moved : 0;
  const accuracy = lines.length ? lines.reduce((a, l) => a + l.accuracy, 0) / lines.length : 0;
  const result: MissionEvaluation["result"] =
    successRate >= 0.8 ? "EXCELLENT" : successRate >= 0.5 ? "GOOD" : successRate >= 0.25 ? "WEAK" : "POOR";
  return {
    evaluatedAt: snap.now,
    lines,
    result,
    successRate,
    accuracy,
    preventedEmpty: lines.some((l, i) => l.salesInWindow > m.lines[i].targetStockBefore),
    preventedWaste: m.lines.some((l, i) => l.sourceWasteUnits >= 1 && lines[i].successRate >= 0.5),
  };
}

export interface LearningState {
  forecastBias: Record<string, number>;
  pairStats: Record<string, PairStat>;
  /** per source fridge (and "_all"): EWMA of moved ÷ recommended */
  acceptance?: Record<string, { ratio: number; n: number }>;
}

export const biasKey = (fridgeId: string, categoryId: string) => `${fridgeId}:${categoryId}`;

export function applyLearning(state: LearningState, m: Mission, ev: MissionEvaluation): void {
  const L = ENGINE_CONFIG.learning;
  for (const l of ev.lines) {
    if (l.moved === 0) continue; // skipped dish — no signal about demand
    const key = pairKey(m.sourceFridgeId, l.targetFridgeId ?? m.targetFridgeId, l.categoryId);
    const ps = state.pairStats[key] ?? { moved: 0, sold: 0, count: 0 };
    ps.moved += l.moved;
    ps.sold += l.soldAttributed;
    ps.count += 1;
    state.pairStats[key] = ps;

    if (l.predicted > 0) {
      const bk = biasKey(l.targetFridgeId ?? m.targetFridgeId, l.categoryId);
      const prev = state.forecastBias[bk] ?? 1;
      const ratio = (l.salesInWindow + 1) / (l.predicted + 1);
      const next = prev * (1 - L.biasRate) + prev * ratio * L.biasRate;
      state.forecastBias[bk] = Math.min(L.biasMax, Math.max(L.biasMin, next));
    }
  }
}
