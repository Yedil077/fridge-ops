import { CATEGORIES } from "../domain/categories";
import type { Fridge, NetworkSnapshot, Product } from "../domain/types";
import { buildTravelMatrix } from "../engine/distance";
import { dayNumber, minuteOfDay } from "../time";
import { categorizeProduct } from "@/services/kitshop/adapter";
import type { KsDataset } from "./dataset";

/**
 * NetworkSnapshot built ONLY from the real KiT Shop copy (no simulator anywhere).
 *  • fridges: our configured points whose ShopId exists in KiT Shop;
 *  • products: food items that sold in 180 days or are in stock now (non-food like cutlery excluded);
 *  • history: fridge × category × day × hour and fridge × product × day from receipt positions (GetSaleById);
 *  • today: sales by quarter-hour and product, revenue; current stock from GetShopStocks.
 * Stock-out quarters are unknown in KiT Shop data → left empty (demand is not censored).
 */

export const HISTORY_DAYS = 180;

/** Not dishes — never forecast or moved. */
const NON_FOOD = /прибор|пакет|салфет|ложк|вилк|трубочк|зубочист|контейнер\b|крышк|стакан\b/i;

export function isFood(name: string, price: number | null): boolean {
  return !NON_FOOD.test(name) && (price === null || price > 0);
}

export function buildKitShopSnapshot(ds: KsDataset, configured: Fridge[], now: number): NetworkSnapshot {
  const today = dayNumber(now);
  const startDay = today - HISTORY_DAYS;
  const fridges = (ds.shops.size ? configured.filter((f) => ds.shops.has(f.externalId)) : configured).map((f) => ({ ...f }));
  const fIdx = new Map(fridges.map((f, i) => [f.externalId, i]));

  // products: sold in the window or in stock at one of our fridges
  const used = new Map<string, { qty: number; price: number | null; name: string | null }>();
  for (const sale of ds.sales.values()) {
    if (!fIdx.has(sale.shopId) || dayNumber(sale.soldAt) < startDay) continue;
    for (const p of ds.positions.get(sale.saleId) ?? []) {
      const u = used.get(p.productId) ?? { qty: 0, price: p.price, name: null };
      u.qty += p.qty;
      used.set(p.productId, u);
    }
  }
  for (const [shopId, m] of ds.stock) if (fIdx.has(shopId)) for (const [pid, q] of m) if (q > 0 && !used.has(pid)) used.set(pid, { qty: 0, price: null, name: null });
  const products: Product[] = [];
  const categorizedBy = { group: 0, name: 0 };
  for (const [pid, u] of used) {
    const cat = ds.products.get(pid);
    const name = cat?.name ?? `Товар #${pid}`;
    const price = cat?.price ?? u.price;
    if (!isFood(name, price)) continue;
    // category: KiT Shop product group first, the dish name only as a fallback
    const group = cat?.groupId !== null && cat?.groupId !== undefined ? ds.groups.get(cat.groupId)?.name : null;
    const c = categorizeProduct(name, group);
    categorizedBy[c.by]++;
    products.push({
      id: `K${pid}`,
      externalId: pid,
      name: name.replace(/\s+/g, " ").trim(),
      categoryId: c.category,
      price: price ?? 0,
      sku: cat?.vendorCode || pid.slice(-5),
      imageUrl: null,
      barcode: cat?.barcode ?? null,
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
  const firstDay = new Array<number>(F).fill(Infinity);

  for (const sale of ds.sales.values()) {
    const f = fIdx.get(sale.shopId);
    if (f === undefined) continue;
    const day = dayNumber(sale.soldAt);
    if (day < firstDay[f]) firstDay[f] = day;
    if (day < startDay || day > today) continue;
    const isToday = day === today;
    if (isToday && sale.total !== null) revenue[f] += sale.total;
    const lines = ds.positions.get(sale.saleId);
    if (!lines) continue;
    const minute = minuteOfDay(sale.soldAt);
    for (const line of lines) {
      const p = pIdx.get(line.productId);
      if (p === undefined) continue;
      const c = catIdx.get(products[p].categoryId)!;
      if (isToday) {
        quarterSales[(f * C + c) * 96 + Math.floor(minute / 15)] += line.qty;
        productSales[f * P + p] += line.qty;
        if (sale.total === null) revenue[f] += line.qty * (line.price ?? 0);
      } else {
        const d = day - startDay;
        hourly[((f * C + c) * D + d) * 24 + Math.floor(minute / 60)] += line.qty;
        productDaily[(f * P + p) * D + d] += line.qty;
      }
    }
  }
  fridges.forEach((fr, i) => {
    if (Number.isFinite(firstDay[i])) fr.activeSinceDay = firstDay[i];
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

  return {
    now,
    fridges,
    categories: CATEGORIES,
    products,
    history: { startDay, days: D, hourly, productDaily, holidays: [] },
    today: { day: today, quarterSales, productSales, stockoutQuarters: new Uint8Array(F * C * 96), revenue },
    stock,
    travelMinutes: buildTravelMatrix(fridges),
    version: `ks:${ds.version}:${Math.floor(now / 900_000)}`,
    source: "kitshop",
    categorizedBy,
  };
}
