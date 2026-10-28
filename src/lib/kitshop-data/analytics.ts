import { CATEGORIES } from "../domain/categories";
import type { CategoryId, DataCheck, DayStatus, ProductEvents } from "../domain/types";
import { analyseBatches } from "../engine/batches";
import { storedStatFor, type StoredStat } from "../engine/productNorm";
import { shelfHoursFor, type ShelfLifeSettings } from "../config/shelfLife";
import { dayNumber, minuteOfDay } from "../time";
import { categorizeProduct } from "@/services/kitshop/adapter";
import type { KsDataset } from "./dataset";
import type { HistorySource, ShopHistory } from "./history";
import { fillDirection } from "./fillDirection";
import { continuityFrom, nightlyChecks } from "./checks";

/**
 * NIGHTLY ANALYTICS JOB — the only place that looks at 180 days of KiT Shop history.
 * One shop at a time (memory stays small): its receipts, lines and loads / unloads / write-offs are read from the
 * history source (PostgreSQL in production), turned into
 *   • product_shop_daily — per dish and day: delivered, sold, unloaded, written off, closing stock, had stock;
 *   • product_shop_stats — per dish: sales 7/14/30/60/180, deliveries, sell-through, the norm (engine/productNorm.ts);
 *   • the category × hour curve of the fridge (forecasts), continuity of the last 30 days, the nightly data checks,
 * and saved. During the day nothing of this is recomputed — the screens read the saved result.
 */

export const HISTORY_DAYS = 180;
const DAY = 86_400_000;

/** Not dishes — never forecast or moved. */
const NON_FOOD = /прибор|пакет|салфет|ложк|вилк|трубочк|зубочист|контейнер\b|крышк|стакан\b/i;
export function isFood(name: string, price: number | null): boolean {
  return !NON_FOOD.test(name) && (price === null || price > 0);
}

export interface DailyRow {
  day: number;
  delivered: number;
  sold: number;
  removed: number;
  writtenOff: number;
  closingStock: number | null;
  hadStock: boolean;
  quality: "OK" | "GAP";
}

export interface ShopAnalytics {
  shopId: string;
  /** category × day × hour sales (index (c * days + d) * 24 + h), CATEGORIES order */
  cube: Float32Array;
  /** product id → sold per history day */
  daily: Map<string, Float32Array>;
  /** product id → the facts per day (for product_shop_daily) */
  dailyRows: Map<string, DailyRow[]>;
  receiptsByDay: Int32Array;
  stats: Map<string, StoredStat>;
  continuity: DayStatus[];
  checks: DataCheck[];
}

export interface AnalyticsCache {
  runAt: number;
  ms: number;
  /** the job's day: history covers [startDay, startDay + days) = up to the day before */
  day: number;
  startDay: number;
  days: number;
  historyFromDay: number;
  fillupsFromDay: number | null;
  /** product id → category (as the job saw it) */
  categories: Record<string, CategoryId>;
  shops: Map<string, ShopAnalytics>;
  rowsRead: { receipts: number; lines: number; fillupLines: number };
  shelfLifeKey: string;
}

export interface JobContext {
  now: number;
  /** our fridges' shop ids */
  shopIds: string[];
  ds: Pick<KsDataset, "products" | "groups" | "stock" | "stockCoverage" | "state" | "shops">;
  historyFromDay: number;
  fillupsFromDay: number | null;
  /** receipts with lines and loads are complete from this moment */
  eventsFrom: number;
  shelfLife?: ShelfLifeSettings;
}

export function productCategory(ds: JobContext["ds"], pid: string, price: number | null = null): { id: CategoryId; food: boolean; name: string } {
  const cat = ds.products.get(pid);
  const name = cat?.name ?? `Товар #${pid}`;
  const group = cat?.groupId !== null && cat?.groupId !== undefined ? ds.groups.get(cat.groupId)?.name : null;
  return { id: categorizeProduct(name, group).category, food: isFood(name, cat?.price ?? price), name };
}

/** The heavy work for ONE shop. Pure: history in, results out. */
export function analyseShop(h: ShopHistory, shopId: string, ctx: JobContext): ShopAnalytics {
  const today = dayNumber(ctx.now);
  const startDay = today - HISTORY_DAYS;
  const D = HISTORY_DAYS;
  const C = CATEGORIES.length;
  const catIdx = new Map(CATEGORIES.map((c, i) => [c.id, i]));
  const cube = new Float32Array(C * D * 24);
  const receiptsByDay = new Int32Array(D);
  const per = new Map<string, { sold: Float32Array; loaded: Float32Array; removed: Float32Array; writtenOff: Float32Array; first: number | null; ev: { at: number; qty: number; kind: number }[] }>();
  const product = (pid: string) => {
    let x = per.get(pid);
    if (!x) per.set(pid, (x = { sold: new Float32Array(D), loaded: new Float32Array(D), removed: new Float32Array(D), writtenOff: new Float32Array(D), first: null, ev: [] }));
    return x;
  };
  const catOf = new Map<string, { id: CategoryId; food: boolean }>();
  const cat = (pid: string) => {
    let c = catOf.get(pid);
    if (!c) catOf.set(pid, (c = productCategory(ctx.ds, pid)));
    return c;
  };
  for (const r of h.receipts) {
    const d = dayNumber(r.at) - startDay;
    if (d >= 0 && d < D) receiptsByDay[d]++;
  }
  for (const s of h.sales) {
    const c = cat(s.productId);
    if (!c.food) continue;
    const day = dayNumber(s.at);
    const x = product(s.productId);
    if (x.first === null || day < x.first) x.first = day;
    x.ev.push({ at: s.at, qty: s.qty, kind: 0 });
    const d = day - startDay;
    if (d < 0 || d >= D || day < ctx.historyFromDay) continue;
    x.sold[d] += s.qty;
    cube[((catIdx.get(c.id) ?? 0) * D + d) * 24 + Math.floor(minuteOfDay(s.at) / 60)] += s.qty;
  }
  for (const f of h.fills) {
    if (!cat(f.productId).food) continue;
    const dir = fillDirection(f.type, f.qty);
    const x = product(f.productId);
    const day = dayNumber(f.at);
    if (dir.kind === "load" && (x.first === null || day < x.first)) x.first = day;
    x.ev.push({ at: f.at, qty: Math.abs(dir.delta), kind: dir.kind === "load" ? 1 : dir.kind === "unload" ? 2 : 3 });
    const d = day - startDay;
    if (d < 0 || d >= D) continue;
    if (dir.kind === "load") x.loaded[d] += dir.delta;
    else if (dir.kind === "writeoff") x.writtenOff[d] -= dir.delta;
    else x.removed[d] -= dir.delta;
  }
  const stock = ctx.ds.stock.get(shopId) ?? new Map<string, number>();
  for (const [pid, q] of stock) if (q > 0 && cat(pid).food) product(pid);

  const continuity = continuityFrom(h, ctx.now, ctx.historyFromDay);
  const gapDays = new Set(continuity.filter((d) => d.status === "GAP").map((d) => d.day));
  const fillupsKnown = ctx.fillupsFromDay !== null && ctx.fillupsFromDay <= today - 30;
  const openDay = (day: number) => {
    const d = day - startDay;
    return d >= 0 && d < D && receiptsByDay[d] > 0;
  };

  const stats = new Map<string, StoredStat>();
  const daily = new Map<string, Float32Array>();
  const dailyRows = new Map<string, DailyRow[]>();
  for (const [pid, x] of per) {
    const shelf = shelfHoursFor(ctx.shelfLife, `K${pid}`, cat(pid).id);
    x.ev.sort((a, b) => a.at - b.at || (b.kind === 1 ? 1 : 0) - (a.kind === 1 ? 1 : 0));
    const events: ProductEvents = { at: Float64Array.from(x.ev.map((e) => e.at)), qty: Float32Array.from(x.ev.map((e) => e.qty)), kind: Uint8Array.from(x.ev.map((e) => e.kind)) };
    // the replay ends at the start of today: the night's result is "as of yesterday evening"
    const br = analyseBatches({ events, from: ctx.eventsFrom, now: ctx.now, currentStock: stock.get(pid) ?? 0, shelfHours: shelf.hours, gapDays });
    stats.set(
      pid,
      storedStatFor({
        today,
        startDay,
        historyFromDay: ctx.historyFromDay,
        openDay,
        soldDaily: x.sold,
        loadedDaily: x.loaded,
        removedDaily: x.removed,
        writtenOffDaily: x.writtenOff,
        firstDay: x.first,
        shelf,
        br,
        fillupsKnown,
        gapDays: gapDays.size,
      }),
    );
    daily.set(pid, x.sold);
    // closing stock per day: the movements run backwards from today's stock (null where the data are not complete)
    const rows: DailyRow[] = [];
    // today's movements (after midnight) are not history days: undo them first → the stock at the end of yesterday
    let closing: number | null = stock.get(pid) ?? 0;
    for (const e of x.ev) if (e.at >= today * DAY) closing += e.kind === 1 ? -e.qty : e.qty;
    for (let d = D - 1; d >= 0; d--) {
      const day = startDay + d;
      const known = day >= ctx.historyFromDay && closing !== null && closing >= 0;
      const row: DailyRow = {
        day,
        delivered: Math.round(x.loaded[d]),
        sold: Math.round(x.sold[d]),
        removed: Math.round(x.removed[d]),
        writtenOff: Math.round(x.writtenOff[d]),
        closingStock: known ? Math.round(closing!) : null,
        hadStock: x.sold[d] > 0 || (known && closing! > 0),
        quality: gapDays.has(day) ? "GAP" : "OK",
      };
      if (row.delivered || row.sold || row.removed || row.writtenOff || (row.closingStock ?? 0) > 0) rows.push(row);
      if (closing !== null) closing = closing - x.loaded[d] + x.sold[d] + x.removed[d] + x.writtenOff[d];
    }
    dailyRows.set(pid, rows.reverse());
  }

  return { shopId, cube, daily, dailyRows, receiptsByDay, stats, continuity, checks: nightlyChecks(h, shopId, ctx, continuity) };
}

/** The whole job over a history source: one shop at a time. */
export async function runAnalytics(source: HistorySource, ctx: JobContext, onShop?: (s: ShopAnalytics) => Promise<void>): Promise<AnalyticsCache> {
  const t0 = Date.now();
  const today = dayNumber(ctx.now);
  const startDay = today - HISTORY_DAYS;
  const shops = new Map<string, ShopAnalytics>();
  const rowsRead = { receipts: 0, lines: 0, fillupLines: 0 };
  for (const shopId of ctx.shopIds) {
    const h = await source.shopHistory(shopId, Math.min(startDay * DAY, ctx.eventsFrom), ctx.now);
    rowsRead.receipts += h.receipts.length;
    rowsRead.lines += h.sales.length;
    rowsRead.fillupLines += h.fills.length;
    const sa = analyseShop(h, shopId, ctx);
    // saved shop by shop; the per-day rows are not kept in memory afterwards
    if (onShop) await onShop(sa);
    sa.dailyRows = new Map();
    shops.set(shopId, sa);
  }
  return finish(ctx, shops, rowsRead, t0);
}

/** Same, synchronously from an in-memory dataset (tests, development without PostgreSQL). */
export function runAnalyticsSync(history: { shopHistorySync(shopId: string, from: number, to: number): ShopHistory }, ctx: JobContext): AnalyticsCache {
  const t0 = Date.now();
  const startDay = dayNumber(ctx.now) - HISTORY_DAYS;
  const shops = new Map<string, ShopAnalytics>();
  const rowsRead = { receipts: 0, lines: 0, fillupLines: 0 };
  for (const shopId of ctx.shopIds) {
    const h = history.shopHistorySync(shopId, Math.min(startDay * DAY, ctx.eventsFrom), ctx.now);
    rowsRead.receipts += h.receipts.length;
    rowsRead.lines += h.sales.length;
    rowsRead.fillupLines += h.fills.length;
    shops.set(shopId, analyseShop(h, shopId, ctx));
  }
  return finish(ctx, shops, rowsRead, t0);
}

function finish(ctx: JobContext, shops: Map<string, ShopAnalytics>, rowsRead: AnalyticsCache["rowsRead"], t0: number): AnalyticsCache {
  const today = dayNumber(ctx.now);
  const categories: Record<string, CategoryId> = {};
  for (const s of shops.values()) for (const pid of s.stats.keys()) categories[pid] ??= productCategory(ctx.ds, pid).id;
  return {
    runAt: ctx.now,
    ms: Date.now() - t0,
    day: today,
    startDay: today - HISTORY_DAYS,
    days: HISTORY_DAYS,
    historyFromDay: ctx.historyFromDay,
    fillupsFromDay: ctx.fillupsFromDay,
    categories,
    shops,
    rowsRead,
    shelfLifeKey: JSON.stringify(ctx.shelfLife ?? {}),
  };
}

/** Completeness of the copy: receipts with lines from / loads complete from (as the sync state and queues say). */
export function completeness(
  state: KsDataset["state"],
  now: number,
  newestUndetailedSale: number | null,
  newestUndetailedFillUp: number | null,
): { historyFromDay: number; fillupsFromDay: number | null; eventsFrom: number } {
  const today = dayNumber(now);
  const startDay = today - HISTORY_DAYS;
  const backfillDay = state.backfillFrom !== null ? dayNumber(state.backfillFrom) + 1 : today;
  const undetailedDay = newestUndetailedSale !== null && dayNumber(newestUndetailedSale) < today ? dayNumber(newestUndetailedSale) + 1 : -Infinity;
  const historyFromDay = Math.max(startDay, backfillDay, undetailedDay);
  const settle = now - 30 * 60_000;
  const salesFrom = Math.max(state.backfillFrom ?? now, newestUndetailedSale !== null && newestUndetailedSale < settle ? newestUndetailedSale : -Infinity);
  const fb = state.fillupsBackfillFrom ?? null;
  const fillFrom = fb === null ? now : Math.max(fb, newestUndetailedFillUp !== null && newestUndetailedFillUp < settle ? newestUndetailedFillUp : -Infinity);
  return { historyFromDay, fillupsFromDay: fb === null ? null : Math.ceil(fillFrom / DAY), eventsFrom: Math.max(salesFrom, fillFrom) };
}

// ───────────── persistence: one compact row + the per-dish tables ─────────────

const b64 = (a: Float32Array | Int32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
const f32 = (s: string) => {
  const b = Buffer.from(s, "base64");
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const i32 = (s: string) => {
  const b = Buffer.from(s, "base64");
  return new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

/** The compact part kept in analytics_cache (curves, sold per day, continuity, checks, stats). */
export function serializeCache(c: AnalyticsCache): string {
  return JSON.stringify({
    ...c,
    shops: [...c.shops.values()].map((s) => ({
      shopId: s.shopId,
      cube: b64(s.cube),
      daily: Object.fromEntries([...s.daily].map(([k, v]) => [k, b64(v)])),
      receiptsByDay: b64(s.receiptsByDay),
      stats: Object.fromEntries(s.stats),
      continuity: s.continuity,
      checks: s.checks,
    })),
  });
}

export function deserializeCache(json: string): AnalyticsCache {
  const raw = JSON.parse(json);
  const shops = new Map<string, ShopAnalytics>();
  for (const s of raw.shops ?? [])
    shops.set(s.shopId, {
      shopId: s.shopId,
      cube: f32(s.cube),
      daily: new Map(Object.entries(s.daily as Record<string, string>).map(([k, v]) => [k, f32(v)])),
      dailyRows: new Map(),
      receiptsByDay: i32(s.receiptsByDay),
      stats: new Map(Object.entries(s.stats as Record<string, StoredStat>)),
      continuity: s.continuity,
      checks: s.checks,
    });
  return { ...raw, shops };
}
