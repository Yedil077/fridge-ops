import { CATEGORIES } from "../domain/categories";
import type { Fridge, NetworkSnapshot, Product, ProductDays, ProductEvents } from "../domain/types";
import { buildTravelMatrix } from "../engine/distance";
import type { StoredStat } from "../engine/productNorm";
import type { ShelfLifeSettings } from "../config/shelfLife";
import { dayNumber, minuteOfDay } from "../time";
import type { KsDataset } from "./dataset";
import { dsHistory } from "./history";
import { HISTORY_DAYS, completeness, isFood, productCategory, runAnalyticsSync, type AnalyticsCache } from "./analytics";
import { fillDirection, WRITE_OFF_RULE } from "./fillDirection";
import { liveChecks } from "./checks";

export { fillDirection, WRITE_OFF_RULE, isFood, HISTORY_DAYS };

/**
 * NetworkSnapshot built ONLY from real KiT Shop data (no simulator anywhere), WITHOUT reading the 180-day history:
 *  • history (category × hour curves, sold per dish and day), the norms and the nightly checks — from the nightly
 *    analytics result (kitshop-data/analytics.ts, saved in PostgreSQL);
 *  • today: receipts, stock, the movements of the last days (the stock's age, the delivery still selling) — from what the
 *    5-minute sync keeps in memory.
 * Without a nightly result (`cache` undefined: tests, development file store) it is computed right here from the
 * in-memory dataset; `cache: null` = not ready yet (the screens say the analytics is being computed).
 */

/** movements of the last days kept for "today": the age of the stock, the delivery still selling (≥ the longest shelf life) */
export const RECENT_DAYS = 5;
const DAY = 86_400_000;

export function buildKitShopSnapshot(
  ds: KsDataset,
  configured: Fridge[],
  now: number,
  opts: { cache?: AnalyticsCache | null; shelfLife?: ShelfLifeSettings } = {},
): NetworkSnapshot {
  const today = dayNumber(now);
  const startDay = today - HISTORY_DAYS;
  const fridges = (ds.shops.size ? configured.filter((f) => ds.shops.has(f.externalId)) : configured).map((f) => ({ ...f }));
  const fIdx = new Map(fridges.map((f, i) => [f.externalId, i]));

  let cache = opts.cache;
  if (cache === undefined) {
    // no saved nightly result: compute it from the in-memory dataset (tests / development)
    let newestSale: number | null = null;
    for (const s of ds.sales.values()) if (!s.detailed && (newestSale === null || s.soldAt > newestSale)) newestSale = s.soldAt;
    let newestFill: number | null = null;
    for (const f of ds.fillUps.values()) if (!f.detailed && f.at !== null && (newestFill === null || f.at > newestFill)) newestFill = f.at;
    const c = completeness(ds.state, now, newestSale, newestFill);
    cache = runAnalyticsSync(dsHistory(ds), { now, shopIds: fridges.map((f) => f.externalId), ds, ...c, shelfLife: opts.shelfLife });
  }
  const recentFrom = now - RECENT_DAYS * DAY;

  // products: what the nightly job saw at our fridges + what sold / is in stock now
  const pids = new Set<string>();
  if (cache) for (const f of fridges) for (const pid of cache.shops.get(f.externalId)?.stats.keys() ?? []) pids.add(pid);
  for (const sale of ds.sales.values()) {
    if (!fIdx.has(sale.shopId) || sale.soldAt < recentFrom) continue;
    for (const p of ds.positions.get(sale.saleId) ?? []) pids.add(p.productId);
  }
  for (const [shopId, m] of ds.stock) if (fIdx.has(shopId)) for (const [pid, q] of m) if (q > 0) pids.add(pid);
  const products: Product[] = [];
  const categorizedBy = { group: 0, name: 0 };
  for (const pid of pids) {
    const catalog = ds.products.get(pid);
    const c = productCategory(ds, pid);
    if (!c.food) continue;
    categorizedBy[catalog?.groupId !== null && catalog?.groupId !== undefined && ds.groups.has(catalog.groupId) ? "group" : "name"]++;
    products.push({
      id: `K${pid}`,
      externalId: pid,
      name: c.name.replace(/\s+/g, " ").trim(),
      categoryId: cache?.categories[pid] ?? c.id,
      price: catalog?.price ?? 0,
      sku: catalog?.vendorCode || pid.slice(-5),
      imageUrl: null,
      barcode: catalog?.barcode ?? null,
    });
  }
  products.sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const pIdx = new Map(products.map((p, i) => [p.externalId, i]));
  const catIdx = new Map(CATEGORIES.map((c, i) => [c.id, i]));
  const F = fridges.length;
  const C = CATEGORIES.length;
  const P = products.length;
  const D = HISTORY_DAYS;

  const hourly = new Float32Array(F * C * D * 24);
  const productDaily = new Float32Array(F * P * D);
  const quarterSales = new Float32Array(F * C * 96);
  const productSales = new Float32Array(F * P);
  const revenue = new Float32Array(F);

  // 1. history from the nightly result (its days are shifted if it ran on an earlier day)
  const cacheEnd = cache ? cache.startDay + cache.days : startDay;
  if (cache) {
    const shift = cache.startDay - startDay;
    fridges.forEach((fr, f) => {
      const s = cache!.shops.get(fr.externalId);
      if (!s) return;
      for (let c = 0; c < C; c++)
        for (let d = 0; d < cache!.days; d++) {
          const dd = d + shift;
          if (dd < 0 || dd >= D) continue;
          hourly.set(s.cube.subarray((c * cache!.days + d) * 24, (c * cache!.days + d + 1) * 24), ((f * C + c) * D + dd) * 24);
        }
      for (const [pid, arr] of s.daily) {
        const p = pIdx.get(pid);
        if (p === undefined) continue;
        for (let d = 0; d < cache!.days; d++) {
          const dd = d + shift;
          if (dd >= 0 && dd < D) productDaily[(f * P + p) * D + dd] = arr[d];
        }
      }
    });
  }
  // 2. today + the days after the nightly result (kept in memory), receipts with lines only
  const recentEv = new Map<number, { at: number; qty: number; kind: number }[]>();
  const pushEv = (i: number, e: { at: number; qty: number; kind: number }) => {
    const list = recentEv.get(i) ?? [];
    list.push(e);
    recentEv.set(i, list);
  };
  for (const sale of ds.sales.values()) {
    const f = fIdx.get(sale.shopId);
    if (f === undefined) continue;
    const day = dayNumber(sale.soldAt);
    if (day > today || sale.soldAt < Math.min(recentFrom, cacheEnd * DAY)) continue;
    const isToday = day === today;
    if (isToday && sale.total !== null) revenue[f] += sale.total;
    const lines = ds.positions.get(sale.saleId);
    if (!lines) continue;
    const minute = minuteOfDay(sale.soldAt);
    for (const line of lines) {
      const p = pIdx.get(line.productId);
      if (p === undefined) continue;
      if (sale.soldAt >= recentFrom) pushEv(f * P + p, { at: sale.soldAt, qty: line.qty, kind: 0 });
      const c = catIdx.get(products[p].categoryId)!;
      if (isToday) {
        quarterSales[(f * C + c) * 96 + Math.floor(minute / 15)] += line.qty;
        productSales[f * P + p] += line.qty;
        if (sale.total === null) revenue[f] += line.qty * (line.price ?? 0);
      } else if (day >= cacheEnd) {
        const d = day - startDay;
        hourly[((f * C + c) * D + d) * 24 + Math.floor(minute / 60)] += line.qty;
        productDaily[(f * P + p) * D + d] += line.qty;
      }
    }
  }
  for (const fu of ds.fillUps.values()) {
    const f = fIdx.get(fu.shopId);
    if (f === undefined || fu.at === null || fu.at < recentFrom || fu.at > now || !fu.detailed) continue;
    for (const line of ds.fillUpLines.get(fu.fillupId) ?? []) {
      const p = pIdx.get(line.productId);
      if (p === undefined) continue;
      const dir = fillDirection(fu.type, line.qty);
      pushEv(f * P + p, { at: fu.at, qty: Math.abs(dir.delta), kind: dir.kind === "load" ? 1 : dir.kind === "unload" ? 2 : 3 });
    }
  }
  const recent: (ProductEvents | undefined)[] = new Array(F * P);
  for (const [i, list] of recentEv) {
    list.sort((a, b) => a.at - b.at || (b.kind === 1 ? 1 : 0) - (a.kind === 1 ? 1 : 0));
    recent[i] = { at: Float64Array.from(list.map((e) => e.at)), qty: Float32Array.from(list.map((e) => e.qty)), kind: Uint8Array.from(list.map((e) => e.kind)) };
  }

  const historyFromDay = cache ? Math.max(startDay, cache.historyFromDay) : today;
  fridges.forEach((fr, f) => {
    let first = Infinity;
    const r = cache?.shops.get(fr.externalId)?.receiptsByDay;
    if (r) for (let d = 0; d < r.length; d++) if (r[d] > 0) { first = cache!.startDay + d; break; }
    fr.activeSinceDay = Number.isFinite(first) ? Math.max(first, historyFromDay) : historyFromDay;
    void f;
  });

  const stock = new Int32Array(F * P);
  for (const [shopId, m] of ds.stock) {
    const f = fIdx.get(shopId);
    if (f === undefined) continue;
    for (const [pid, q] of m) {
      const p = pIdx.get(pid);
      if (p !== undefined) stock[f * P + p] = Math.max(0, Math.round(q));
    }
  }

  const stats: (StoredStat | undefined)[] = new Array(F * P);
  fridges.forEach((fr, f) => {
    const s = cache?.shops.get(fr.externalId);
    if (s)
      for (const [pid, st] of s.stats) {
        const p = pIdx.get(pid);
        if (p !== undefined) stats[f * P + p] = st;
      }
  });
  const productDays: ProductDays = {
    stats,
    recent,
    recentFrom,
    checks: fridges.map((fr) => {
      const s = cache?.shops.get(fr.externalId);
      const nightly = s?.checks ?? [{ id: "analytics", label: "Ночной расчёт готов", level: "WARN" as const, detail: "аналитика ещё считается — нормы появятся после первого расчёта" }];
      return [...nightly, ...liveChecks(ds, fr, now, s ? { receiptsByDay: s.receiptsByDay, startDay: cache!.startDay } : null)];
    }),
    continuity: fridges.map((fr) => cache?.shops.get(fr.externalId)?.continuity ?? []),
    fillupsFromDay: cache?.fillupsFromDay ?? null,
    stockHistoryFromDay: ds.state.stockHistoryFrom != null ? dayNumber(ds.state.stockHistoryFrom) : null,
    writeOffRule: WRITE_OFF_RULE,
    analysisAt: cache?.runAt ?? null,
  };

  return {
    now,
    fridges,
    categories: CATEGORIES,
    products,
    history: { startDay, days: D, hourly, productDaily, holidays: [] },
    today: { day: today, quarterSales, productSales, stockoutQuarters: new Uint8Array(F * C * 96), revenue },
    stock,
    travelMinutes: buildTravelMatrix(fridges),
    version: `ks:${ds.version}:${cache?.runAt ?? 0}:${Math.floor(now / 900_000)}`,
    source: "kitshop",
    historyFromDay,
    categorizedBy,
    productDays,
  };
}
