import "server-only";
import type { NetworkSnapshot } from "../domain/types";
import type { AnalysisResult } from "../engine/analysis";
import { buildProfiles, productAffinityByFridge, type FridgeProfile } from "../engine/fridgeProfile";
import type { AppState } from "../store/appStore";
import { fmtHM } from "../time";
import { inMode } from "./views";

/**
 * Аналитика = профили холодильников: норма каждой точки, где сегодня она относительно своей нормы, что нужно и что можно
 * отдать, и сравнение внутри группы перемещения. Recommendations shown here are the SAME open transfers as on the main
 * screen (one source of truth), each explained with the profile numbers of its source and target.
 */

const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export function profilesView(snap: NetworkSnapshot, a: AnalysisResult, state: AppState, untilMinute: number) {
  const profiles = buildProfiles(a.ctx, a.forecasts, a.demandIndex, { demand: a.demand });
  const nameOf = (f: number) => snap.fridges[f].name;

  const rows = profiles.map((p) => {
    const fr = snap.fridges[p.fridgeIndex];
    const byIndex = [...p.categories].filter((c) => c.index > 0).sort((x, y) => y.index - x.index);
    return {
      id: fr.id,
      name: fr.name,
      group: fr.transferGroup,
      confidence: p.confidence,
      dataDays: p.dataDays,
      normalDay: p.normalDay,
      normalByNow: p.normalByNow,
      today: p.today,
      peaks: p.peaks.map((x) => `${fmtHM(x.from * 60)}–${fmtHM((x.to % 24) * 60)}`),
      weekdayIndex: p.weekdayIndex.map((v, i) => ({ day: WD[i], index: v })),
      strongWeekdays: p.strongWeekdays.map((i) => WD[i]),
      weakWeekdays: p.weakWeekdays.map((i) => WD[i]),
      strongest: byIndex[0] ? { name: byIndex[0].name, emoji: byIndex[0].emoji, vsNetworkPct: byIndex[0].vsNetworkPct } : null,
      weakest: byIndex.length ? { name: byIndex[byIndex.length - 1].name, emoji: byIndex[byIndex.length - 1].emoji, vsNetworkPct: byIndex[byIndex.length - 1].vsNetworkPct } : null,
      categories: p.categories,
      topProducts: p.topProducts.map((t) => ({ name: snap.products[t.productIndex].name, perDay: t.perDay, affinity: t.affinity })),
      tags: p.tags,
      summary: p.summary,
      stock: p.categories.reduce((x, c) => x + c.stock, 0),
    };
  });

  // groups: only real transfer groups (a point without a group cannot exchange food)
  const groupNames = [...new Set(snap.fridges.map((f) => f.transferGroup).filter((g): g is string => !!g))].sort();
  const profileOf = (id: string): FridgeProfile | undefined => {
    const f = snap.fridges.findIndex((x) => x.id === id);
    return f >= 0 ? profiles[f] : undefined;
  };

  const groups = groupNames.map((g) => {
    const idx = snap.fridges.map((f, i) => (f.transferGroup === g ? i : -1)).filter((i) => i >= 0);
    const dishes = productAffinityByFridge(a.ctx, idx, 10).map((d) => ({
      name: snap.products[d.productIndex].name,
      affinity: d.affinity,
      best: nameOf(d.best),
    }));
    // open transfers of this group (realtime list), explained by the profiles of both ends
    const transfers = state.missions
      .filter((m) => inMode(m, "realtime") && idx.some((i) => snap.fridges[i].id === m.sourceFridgeId))
      .sort((x, y) => y.priority - x.priority)
      .slice(0, 6)
      .map((m) => {
        const src = profileOf(m.sourceFridgeId);
        return {
          id: m.id,
          from: snap.fridges.find((f) => f.id === m.sourceFridgeId)?.name ?? m.sourceFridgeId,
          urgency: m.urgency,
          lines: m.lines.map((l) => {
            const tgt = profileOf(l.targetFridgeId);
            const tc = tgt?.categories.find((c) => c.id === l.categoryId);
            const sc = src?.categories.find((c) => c.id === l.categoryId);
            return {
              to: snap.fridges.find((f) => f.id === l.targetFridgeId)?.name ?? l.targetFridgeId,
              category: tc ? `${tc.emoji} ${tc.name}` : l.categoryId,
              items: l.products.map((p) => `${p.name} ×${p.qty}`),
              qty: l.recommendedQty,
              why: [
                tc ? `${snap.fridges.find((f) => f.id === l.targetFridgeId)?.name}: нужно ${tc.need} — ${tc.reason}; спрос ${tc.demand === "HIGH" ? "высокий" : tc.demand === "LOW" ? "низкий" : "обычный"} (${tc.index.toFixed(2)}×)` : null,
                tgt && tgt.today.deviationPct !== null ? `сегодня темп ${tgt.today.deviationPct > 0 ? "+" : ""}${tgt.today.deviationPct}% к норме` : null,
                sc ? `${snap.fridges.find((f) => f.id === m.sourceFridgeId)?.name}: можно отдать ${sc.canGive} — ${sc.reason}` : null,
              ].filter((x): x is string => !!x),
            };
          }),
        };
      });
    return {
      name: g,
      fridgeIds: idx.map((i) => snap.fridges[i].id),
      dishes,
      transfers,
    };
  });

  return { now: snap.now, source: snap.source, untilTime: fmtHM(untilMinute), profiles: rows, groups };
}

export type ProfilesView = ReturnType<typeof profilesView>;
