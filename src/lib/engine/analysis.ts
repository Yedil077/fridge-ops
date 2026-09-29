import type { DemandIndexRow, FridgeForecast, FridgePersonality, Mission, NetworkSnapshot } from "../domain/types";
import { biasKey, type LearningState } from "./feedback";
import { forecastFridge } from "./forecast";
import { buildContext, type EngineContext } from "./history";
import { demandIndex, personality } from "./profile";
import { recommend, type MissionDraft, type Reservation } from "./recommend";

/**
 * Hourly analysis pipeline:
 * data → sales velocity → forecast → shortage / surplus → possible transfers → priority → top missions.
 */

export interface AnalysisResult {
  ctx: EngineContext;
  forecasts: FridgeForecast[];
  demandIndex: DemandIndexRow[];
  drafts: MissionDraft[];
}

/** Accepted / in-progress missions reserve their quantities so a new analysis does not duplicate them. */
export function reservationsFrom(missions: Mission[], snap: NetworkSnapshot): Reservation[] {
  const idx = new Map(snap.fridges.map((f, i) => [f.id, i]));
  const pidx = new Map(snap.products.map((p, i) => [p.id, i]));
  const out: Reservation[] = [];
  for (const m of missions) {
    if (m.status !== "ACCEPTED" && m.status !== "IN_PROGRESS") continue;
    const s = idx.get(m.sourceFridgeId);
    if (s === undefined) continue;
    for (const l of m.lines) {
      const t = idx.get(l.targetFridgeId ?? m.targetFridgeId);
      if (t === undefined) continue;
      out.push({
        sourceIndex: s,
        targetIndex: t,
        categoryIndex: snap.categories.findIndex((c) => c.id === l.categoryId),
        qty: l.recommendedQty,
        products: l.products
          .map((p) => ({ productIndex: pidx.get(p.productId) ?? -1, qty: p.qty }))
          .filter((p) => p.productIndex >= 0),
      });
    }
  }
  return out;
}

export function analyze(snap: NetworkSnapshot, learning: LearningState, activeMissions: Mission[]): AnalysisResult {
  const ctx = buildContext(snap, (f, c) => learning.forecastBias[biasKey(snap.fridges[f].id, snap.categories[c].id)] ?? 1);
  const forecasts = snap.fridges.map((_, f) => forecastFridge(ctx, f));
  const di = demandIndex(ctx);
  const drafts = recommend(ctx, forecasts, reservationsFrom(activeMissions, snap), learning.pairStats);
  return { ctx, forecasts, demandIndex: di, drafts };
}

export function personalities(ctx: EngineContext, di: DemandIndexRow[]): FridgePersonality[] {
  return ctx.snap.fridges.map((_, f) => personality(ctx, f, di[f]));
}
