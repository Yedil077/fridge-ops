import "server-only";
import type { NetworkSnapshot } from "../domain/types";
import type { AnalysisResult } from "../engine/analysis";
import { QUALITY_TEXT, STATUS_TEXT, type ProductStat, type ProductStatus } from "../engine/productNorm";

/**
 * Аналитика «Все холодильники»: the same product × fridge numbers (engine/productNorm.ts, engine/demand.ts), only
 * added up over the fridges — nothing is computed differently. First the fridges side by side, then every dish of the
 * network with its total and the per-fridge breakdown. Whole units only.
 */

export function networkAnalyticsView(snap: NetworkSnapshot, a: AnalysisResult) {
  const P = snap.products.length;
  const pd = snap.productDays;
  const now = a.demand.NOW.products;
  const catById = new Map(snap.categories.map((c) => [c.id, c]));

  // ── the fridges side by side
  const fridges = snap.fridges.map((fr, f) => {
    const rows = a.products.byFridge[f] ?? [];
    const s = (k: (r: ProductStat) => number) => rows.reduce((acc, r) => acc + k(r), 0);
    const checks = pd?.checks[f] ?? [];
    const failed = checks.filter((c) => c.level === "FAIL");
    return {
      id: fr.id,
      name: fr.name,
      group: fr.transferGroup ?? null,
      sold7: s((r) => r.sold.d7),
      sold30: s((r) => r.sold.d30),
      loaded30: s((r) => r.loaded30),
      removed30: s((r) => r.removed30),
      writtenOff30: s((r) => r.writtenOff30),
      stock: s((r) => r.stock),
      dishesSelling: rows.filter((r) => r.sold.d30 > 0).length,
      more: rows.filter((r) => r.status === "MORE").length,
      tooMuch: rows.filter((r) => r.status === "TOO_MUCH" || r.status === "LESS").length,
      needNow: rows.reduce((acc, r) => acc + (now[f * P + r.p]?.need ?? 0), 0),
      canGiveNow: rows.reduce((acc, r) => acc + (now[f * P + r.p]?.surplus ?? 0), 0),
      checksFailed: failed.map((c) => c.label),
      checksWarn: checks.filter((c) => c.level === "WARN").length,
    };
  });

  // ── every dish of the network: totals + per fridge
  const byProduct = new Map<number, { f: number; st: ProductStat }[]>();
  a.products.byFridge.forEach((rows, f) => rows.forEach((st) => byProduct.set(st.p, [...(byProduct.get(st.p) ?? []), { f, st }])));
  const ORDER: ProductStatus[] = ["MORE", "TOO_MUCH", "LESS", "RARE", "NORMAL", "NO_DATA", "UNUSED"];
  const products = [...byProduct.entries()].map(([p, list]) => {
    const pr = snap.products[p];
    const cat = catById.get(pr.categoryId)!;
    const s = (k: (r: ProductStat) => number) => list.reduce((acc, x) => acc + k(x.st), 0);
    const withNorm = list.filter((x) => x.st.norm);
    const statusCounts = Object.fromEntries(ORDER.map((st) => [st, list.filter((x) => x.st.status === st).length])) as Record<ProductStatus, number>;
    return {
      productId: pr.id,
      name: pr.name,
      category: { id: cat.id, name: cat.name, emoji: cat.emoji },
      sold: { d7: s((r) => r.sold.d7), d30: s((r) => r.sold.d30), d60: s((r) => r.sold.d60), d90: s((r) => r.sold.d90), d180: s((r) => r.sold.d180) },
      soldToday: s((r) => r.soldToday),
      fridgesSelling30: list.filter((x) => x.st.sold.d30 > 0).length,
      fridgesTotal: list.length,
      loaded30: s((r) => r.loaded30),
      removed30: s((r) => r.removed30),
      writtenOff30: s((r) => r.writtenOff30),
      stock: s((r) => r.stock),
      /** the sum of the fridges' norms = how many the network needs per day */
      norm: withNorm.length
        ? { min: withNorm.reduce((acc, x) => acc + x.st.norm!.min, 0), rec: withNorm.reduce((acc, x) => acc + x.st.norm!.rec, 0), max: withNorm.reduce((acc, x) => acc + x.st.norm!.max, 0) }
        : null,
      fridgesWithNorm: withNorm.length,
      needNow: list.reduce((acc, x) => acc + (now[x.f * P + p]?.need ?? 0), 0),
      canGiveNow: list.reduce((acc, x) => acc + (now[x.f * P + p]?.surplus ?? 0), 0),
      statusCounts,
      qualityGood: list.filter((x) => x.st.quality === "GOOD").length,
      qualityBad: list.filter((x) => x.st.quality === "BAD").length,
      perFridge: list
        .map(({ f, st }) => ({
          fridgeId: snap.fridges[f].id,
          fridge: snap.fridges[f].name,
          sold7: st.sold.d7,
          sold30: st.sold.d30,
          salesDays30: st.salesDays30,
          openDays30: st.openDays30,
          stock: st.stock,
          loaded30: st.loaded30,
          removed30: st.removed30,
          writtenOff30: st.writtenOff30,
          norm: st.norm,
          need: now[f * P + p]?.need ?? 0,
          surplus: now[f * P + p]?.surplus ?? 0,
          status: st.status,
          statusText: STATUS_TEXT[st.status],
          qualityText: QUALITY_TEXT[st.quality],
          quality: st.quality,
        }))
        .sort((x, y) => y.sold30 - x.sold30 || y.stock - x.stock),
    };
  });
  products.sort((x, y) => y.sold.d30 - x.sold.d30 || y.stock - x.stock || x.name.localeCompare(y.name, "ru"));

  const t = (k: (r: (typeof fridges)[number]) => number) => fridges.reduce((acc, r) => acc + k(r), 0);
  const categories = snap.categories.map((c) => ({
    id: c.id,
    name: c.name,
    emoji: c.emoji,
    sold30: products.reduce((acc, r) => acc + (r.category.id === c.id ? r.sold.d30 : 0), 0),
  }));

  return {
    scope: "network" as const,
    now: snap.now,
    source: snap.source,
    summary: {
      sold30: t((r) => r.sold30),
      loaded30: t((r) => r.loaded30),
      removed30: t((r) => r.removed30),
      writtenOff30: t((r) => r.writtenOff30),
      stock: t((r) => r.stock),
      fridges: fridges.length,
      fridgesFailed: fridges.filter((r) => r.checksFailed.length).length,
      dishes: products.length,
      dishesSelling: products.filter((r) => r.sold.d30 > 0).length,
    },
    categories,
    fridges,
    products,
  };
}

export type NetworkAnalyticsView = ReturnType<typeof networkAnalyticsView>;
