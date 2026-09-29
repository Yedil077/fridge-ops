import { histDay, type EngineContext } from "./history";

/**
 * Product-level intelligence: fridge × product.
 *  • perDay   — average sales of the dish per working day (last 90 days, recency-weighted)
 *  • share    — share of the dish inside its category at this fridge (smoothed toward the network)
 *  • affinity — 0–100: how much better this fridge sells the dish than the network (50 = average)
 */
export interface ProductModel {
  perDay: Float64Array; // F*P
  share: Float64Array; // F*P
  affinity: Float64Array; // F*P
  networkPerDay: Float64Array; // P
}

const cache = new WeakMap<EngineContext, ProductModel>();

export function productModel(ctx: EngineContext): ProductModel {
  const hit = cache.get(ctx);
  if (hit) return hit;
  const { F, P, D, snap } = ctx;
  const perDay = new Float64Array(F * P);
  const { productDaily } = snap.history;

  for (let f = 0; f < F; f++) {
    let wsum = 0;
    const acc = new Float64Array(P);
    for (let d = 0; d < D; d++) {
      if (!ctx.sample[f * D + d] || ctx.today - histDay(ctx, d) > 90) continue;
      const w = ctx.dayWeight[d];
      wsum += w;
      for (let p = 0; p < P; p++) acc[p] += w * productDaily[(f * P + p) * D + d];
    }
    for (let p = 0; p < P; p++) perDay[f * P + p] = wsum > 0 ? acc[p] / wsum : 0;
  }

  const networkPerDay = new Float64Array(P);
  for (let p = 0; p < P; p++) {
    let s = 0;
    let n = 0;
    for (let f = 0; f < F; f++) {
      if (perDay[f * P + p] > 0) {
        s += perDay[f * P + p];
        n++;
      }
    }
    networkPerDay[p] = n ? s / n : 0;
  }

  // share inside the category, smoothed toward the network mix of the category
  const share = new Float64Array(F * P);
  const prior = 1.5;
  for (const prods of ctx.catProducts) {
    const netCat = prods.reduce((a, p) => a + networkPerDay[p], 0) || 1;
    for (let f = 0; f < F; f++) {
      const own = prods.reduce((a, p) => a + perDay[f * P + p], 0);
      for (const p of prods) share[f * P + p] = (perDay[f * P + p] + prior * (networkPerDay[p] / netCat)) / (own + prior);
    }
  }

  const affinity = new Float64Array(F * P);
  for (let f = 0; f < F; f++)
    for (let p = 0; p < P; p++) {
      const ratio = (perDay[f * P + p] + 0.2) / (networkPerDay[p] + 0.2);
      affinity[f * P + p] = Math.round(Math.min(99, Math.max(1, 50 + 30 * Math.log2(ratio))));
    }

  const model = { perDay, share, affinity, networkPerDay };
  cache.set(ctx, model);
  return model;
}
