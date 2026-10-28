import { CATEGORIES } from "../domain/categories";
import type { Fridge, NetworkSnapshot, Product, ProductDays } from "../domain/types";
import { buildTravelMatrix } from "../engine/distance";
import { dayNumber, minuteOfDay } from "../time";
import { categorizeProduct } from "@/services/kitshop/adapter";
import type { KsDataset } from "./dataset";
import { buildTimeline, type TimelineInput } from "./stockTimeline";
import { continuity, fridgeChecks } from "./checks";

/**
 * NetworkSnapshot built ONLY from the real KiT Shop copy (no simulator anywhere).
 *  • fridges: our configured points whose ShopId exists in KiT Shop;
 *  • products: food items that sold in 180 days or are in stock now (non-food like cutlery excluded);
 *  • history: fridge × category × day × hour and fridge × product × day from receipt positions (GetSaleById);
 *  • today: sales by quarter-hour and product, revenue; current stock from GetShopStocks.
 *  • productDays: availability per dish and day (5-minute stock history + reconstruction from receipts and loads /
 *    unloads), loads, unloads and confirmed write-offs — the base of the product analytics.
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

  // History is trusted only where EVERY receipt already has its product lines (GetSaleById goes newest first):
  // a past day with receipts still waiting would look like a weak day and pull the norm down. Those days, and all older
  // ones, are left out → the profile has less history and therefore a lower confidence until the backfill is done.
  let newestIncomplete = -Infinity;
  for (const sale of ds.sales.values()) {
    if (sale.detailed) continue;
    const day = dayNumber(sale.soldAt);
    if (day < today && day > newestIncomplete) newestIncomplete = day;
  }
  const backfillDay = ds.state.backfillFrom !== null ? dayNumber(ds.state.backfillFrom) + 1 : today;
  const historyFromDay = Math.max(startDay, newestIncomplete + 1, backfillDay);

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
        if (day < historyFromDay) continue;
        const d = day - startDay;
        hourly[((f * C + c) * D + d) * 24 + Math.floor(minute / 60)] += line.qty;
        productDaily[(f * P + p) * D + d] += line.qty;
      }
    }
  }
  // days before the complete history are "unknown", not "closed": the engine must not count them as days without sales
  fridges.forEach((fr, i) => {
    if (Number.isFinite(firstDay[i])) fr.activeSinceDay = Math.max(firstDay[i], historyFromDay);
    else fr.activeSinceDay = historyFromDay;
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

  const productDays = buildProductDays(ds, fridges, products, startDay, D, now, historyFromDay);

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
    historyFromDay,
    categorizedBy,
    productDays,
  };
}

/**
 * Direction of a fill-up line by its KiT Shop operation type (FillupType: 1 загрузка, 2 разгрузка, 3 списание — the
 * company's own reference, «Справочник» in the KiT Shop integration sheet). KiT Shop gives the quantity of an unload /
 * write-off as a POSITIVE number, so the sign alone must not decide. Unknown type → the sign.
 *   load → +qty; unload → −|qty| ("снято": moves, returns, anything); write-off → −|qty| and counted as a CONFIRMED write-off.
 */
export function fillDirection(type: number | null, qty: number): { delta: number; kind: "load" | "unload" | "writeoff" } {
  if (type === 3) return { delta: -Math.abs(qty), kind: "writeoff" };
  if (type === 2) return { delta: -Math.abs(qty), kind: "unload" };
  if (type === 1) return { delta: qty, kind: qty >= 0 ? "load" : "unload" };
  return { delta: qty, kind: qty >= 0 ? "load" : "unload" };
}
export const WRITE_OFF_RULE = "операция KiT Shop с типом «Списание» (FillupType 3); «Разгрузка» (FillupType 2) — это только «снято»: перенос, возврат или другое";

const pdCache = new WeakMap<KsDataset, { key: string; value: ProductDays }>();

/**
 * Availability and loads / unloads per fridge × dish × history day. Depends only on the data (not on the minute),
 * so it is rebuilt when the sync changed something.
 */
function buildProductDays(ds: KsDataset, fridges: Fridge[], products: Product[], startDay: number, D: number, now: number, historyFromDay: number): ProductDays {
  // the data checks look at stock freshness → rebuilt at least every 5 minutes
  const key = `${ds.version}:${Math.floor(now / 300_000)}:${fridges.map((f) => f.externalId).join(",")}:${products.length}`;
  const hit = pdCache.get(ds);
  if (hit?.key === key) return hit.value;
  const F = fridges.length;
  const P = products.length;
  const fIdx = new Map(fridges.map((f, i) => [f.externalId, i]));
  const pIdx = new Map(products.map((p, i) => [p.externalId, i]));
  const at = (f: number, p: number, d: number) => (f * P + p) * D + d;
  const avail = new Float32Array(F * P * D).fill(NaN);
  const eod = new Float32Array(F * P * D).fill(NaN);
  const ranOut = new Uint8Array(F * P * D);
  const availFact = new Float32Array(F * P * D).fill(NaN);
  const eodFact = new Float32Array(F * P * D).fill(NaN);
  const ranOutFact = new Uint8Array(F * P * D);
  const loaded = new Float32Array(F * P * D);
  const removed = new Float32Array(F * P * D);
  const writtenOff = new Float32Array(F * P * D);
  const firstDay = new Int32Array(F * P).fill(-1);
  const seen = (f: number, p: number, day: number) => {
    const i = f * P + p;
    if (firstDay[i] < 0 || day < firstDay[i]) firstDay[i] = day;
  };

  // complete only where every receipt / fill-up has its lines (the newest ones get lines within a tick or two)
  const settle = now - 30 * 60_000;
  let salesFrom = ds.state.backfillFrom ?? now;
  for (const s of ds.sales.values()) if (!s.detailed && s.soldAt < settle && s.soldAt > salesFrom) salesFrom = s.soldAt;
  const fb = ds.state.fillupsBackfillFrom ?? null;
  let fillFrom = fb ?? now;
  for (const f of ds.fillUps.values()) if (!f.detailed && f.at !== null && f.at < settle && f.at > fillFrom) fillFrom = f.at;
  const validFrom = Math.max(salesFrom, fillFrom);

  // raw movements per fridge × dish for the delivery batches (engine/batches.ts)
  const evAt = new Map<number, number[]>();
  const evQty = new Map<number, number[]>();
  const evKind = new Map<number, number[]>();
  const pushEv = (i: number, t: number, q: number, k: number) => {
    if (t < validFrom - 4 * 86_400_000) return;
    if (!evAt.has(i)) {
      evAt.set(i, []);
      evQty.set(i, []);
      evKind.set(i, []);
    }
    evAt.get(i)!.push(t);
    evQty.get(i)!.push(q);
    evKind.get(i)!.push(k);
  };
  const perShop = new Map<string, { sales: TimelineInput["sales"]; fills: TimelineInput["fills"] }>();
  const shopOf = (id: string) => {
    let x = perShop.get(id);
    if (!x) perShop.set(id, (x = { sales: [], fills: [] }));
    return x;
  };
  for (const sale of ds.sales.values()) {
    const f = fIdx.get(sale.shopId);
    if (f === undefined || !sale.detailed) continue;
    const ev = shopOf(sale.shopId);
    for (const line of ds.positions.get(sale.saleId) ?? []) {
      ev.sales.push({ at: sale.soldAt, productId: line.productId, qty: line.qty });
      const p = pIdx.get(line.productId);
      if (p !== undefined) {
        seen(f, p, dayNumber(sale.soldAt));
        pushEv(f * P + p, sale.soldAt, line.qty, 0);
      }
    }
  }
  for (const fu of ds.fillUps.values()) {
    const f = fIdx.get(fu.shopId);
    if (f === undefined || fu.at === null || !fu.detailed) continue;
    const ev = shopOf(fu.shopId);
    const day = dayNumber(fu.at);
    for (const line of ds.fillUpLines.get(fu.fillupId) ?? []) {
      const dir = fillDirection(fu.type, line.qty);
      ev.fills.push({ at: fu.at, productId: line.productId, qty: dir.delta });
      const p = pIdx.get(line.productId);
      if (p === undefined) continue;
      pushEv(f * P + p, fu.at, Math.abs(dir.delta), dir.kind === "load" ? 1 : dir.kind === "unload" ? 2 : 3);
      if (dir.kind === "load") seen(f, p, day);
      const d = day - startDay;
      if (d < 0 || d >= D) continue;
      if (dir.kind === "load") loaded[at(f, p, d)] += dir.delta;
      else if (dir.kind === "writeoff") writtenOff[at(f, p, d)] -= dir.delta;
      else removed[at(f, p, d)] -= dir.delta;
    }
  }

  let fixes = 0;
  let firstCoverage: number | null = null;
  const unbalanced: string[] = [];
  const balancedByShop = new Map<string, boolean>();
  for (const [shopId, f] of fIdx) {
    const history = ds.stockHistory.get(shopId) ?? new Map();
    const coverage = ds.stockCoverage.get(shopId) ?? [];
    if (coverage.length && (firstCoverage === null || coverage[0][0] < firstCoverage)) firstCoverage = coverage[0][0];
    for (const [pid, list] of history) {
      const p = pIdx.get(pid);
      const firstStocked = list.find((x: { qty: number }) => x.qty > 0);
      if (p !== undefined && firstStocked) seen(f, p, dayNumber(firstStocked.at));
    }
    const ev = perShop.get(shopId) ?? { sales: [], fills: [] };
    // the reconstruction is only as good as the loads: if KiT Shop shows far fewer units loaded than sold and taken out,
    // loads go another way (not through GetFillUps) — then the past stock would be invented → stock history only
    let sold = 0;
    let moved = 0;
    for (const s of ev.sales) if (s.at >= validFrom) sold += s.qty;
    for (const x of ev.fills) if (x.at >= validFrom) moved += x.qty;
    let current = 0;
    for (const q of (ds.stock.get(shopId) ?? new Map<string, number>()).values()) current += q;
    // stock at validFrom implied by the movements: start + loaded − taken out − sold = now
    const impliedStart = current + sold - moved;
    const balanced = impliedStart <= Math.max(60, 3 * current) && impliedStart >= -20;
    if (!balanced) unbalanced.push(fridges[f].name);
    balancedByShop.set(shopId, balanced);
    const tl = buildTimeline({
      sales: ev.sales,
      fills: ev.fills,
      history,
      coverage,
      current: ds.stock.get(shopId) ?? new Map(),
      currentAt: ds.stockAt.get(shopId) ?? now,
      validFrom: balanced ? validFrom : Infinity,
      startDay,
      days: D,
    });
    fixes += tl.fixes;
    for (const [pid, dd] of tl.dishes) {
      const p = pIdx.get(pid);
      if (p === undefined) continue;
      avail.set(dd.avail, at(f, p, 0));
      eod.set(dd.eod, at(f, p, 0));
      ranOut.set(dd.ranOut, at(f, p, 0));
      availFact.set(dd.availFact, at(f, p, 0));
      eodFact.set(dd.eodFact, at(f, p, 0));
      ranOutFact.set(dd.ranOutFact, at(f, p, 0));
    }
  }

  // events sorted by time (a load before a sale at the same second)
  const events: ProductDays["events"] = new Array(F * P);
  for (const [i, ats] of evAt) {
    const qs = evQty.get(i)!;
    const ks = evKind.get(i)!;
    const order = ats.map((_, j) => j).sort((x, y) => ats[x] - ats[y] || (ks[x] === 1 ? -1 : 0) - (ks[y] === 1 ? -1 : 0));
    events[i] = { at: Float64Array.from(order.map((j) => ats[j])), qty: Float32Array.from(order.map((j) => qs[j])), kind: Uint8Array.from(order.map((j) => ks[j])) };
  }
  const continuityAll = fridges.map((fr) => continuity(ds, fr, now, historyFromDay));

  const today = dayNumber(now);
  const knownDay = Math.min(unbalanced.length < fIdx.size ? Math.ceil(validFrom / 86_400_000) : Infinity, firstCoverage !== null ? dayNumber(firstCoverage) + 1 : Infinity);
  const value: ProductDays = {
    avail,
    ranOut,
    eod,
    availFact,
    ranOutFact,
    eodFact,
    loaded,
    removed,
    writtenOff,
    firstDay,
    fillupsFromDay: fb === null ? null : Math.ceil(fillFrom / 86_400_000),
    stockKnownFromDay: knownDay < today ? knownDay : null,
    stockHistoryFromDay: firstCoverage === null ? null : dayNumber(firstCoverage),
    reconstructionFixes: fixes,
    unbalanced,
    writeOffRule: WRITE_OFF_RULE,
    checks: fridges.map((fr, f) =>
      fridgeChecks(ds, fr, now, {
        historyFromDay,
        fillupsFromDay: fb === null ? null : Math.ceil(fillFrom / 86_400_000),
        balanced: balancedByShop.get(fr.externalId) ?? true,
        continuity: continuityAll[f],
      }),
    ),
    events,
    eventsFrom: validFrom,
    continuity: continuityAll,
  };
  pdCache.set(ds, { key, value });
  return value;
}
