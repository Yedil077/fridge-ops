import "server-only";
import type { NetworkSnapshot } from "../domain/types";
import type { AnalysisResult } from "../engine/analysis";
import { computeTomorrow } from "../engine/tomorrow";
import type { KitShopLive } from "./kitshopLive";
import { productCategory, isFood } from "../kitshop-data/analytics";
import { parseCsv, sheetId } from "./sheetCompare";
import { dayNumber } from "../time";

/**
 * ЗАВТРА: the menu of a date (set by the kitchen / manager) × our fridges → how many to put, whole units.
 * The numbers come from the nightly result + today's live stock (engine/tomorrow.ts); nothing heavy runs here.
 * Every shown recommendation is saved (tomorrow_plan.recommended_qty) next to the manager's own number (manual_qty) —
 * later: recommended vs put vs sold.
 */

const DAY = 86_400_000;
export const isoDay = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
export const dayOfIso = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
const saved = new Map<string, string>();

export async function tomorrowView(live: KitShopLive, snap: NetworkSnapshot, a: AnalysisResult, dateIso: string | null) {
  const day = dateIso && /^\d{4}-\d{2}-\d{2}$/.test(dateIso) ? dayOfIso(dateIso) : dayNumber(snap.now) + 1;
  const date = isoDay(day);
  const menuRows = await live.repo.getMenu(date);
  const cache = live.analytics;
  const cells = computeTomorrow({
    snap,
    forecasts: a.forecasts,
    stats: a.products,
    menu: menuRows.map((m) => `K${m.productId}`),
    day,
    receiptsByDay: cache
      ? (shopId, d) => {
          const r = cache.shops.get(shopId)?.receiptsByDay;
          const i = d - cache.startDay;
          return r && i >= 0 && i < r.length ? r[i] : null;
        }
      : undefined,
  });

  // keep what the system recommended (only when it changed)
  const rows = cells.map((c) => ({
    shopId: c.shopId,
    productId: c.productId.replace(/^K/, ""),
    recommendedQty: c.qty,
    recMin: c.range?.min ?? null,
    recMax: c.range?.max ?? null,
    expectedLeft: c.expectedLeft,
    confidence: c.confidence,
    reason: { ...c.reason, tag: c.tag, base: c.base },
    updatedAt: Date.now(),
  }));
  const sig = JSON.stringify(rows.map((r) => [r.shopId, r.productId, r.recommendedQty, r.expectedLeft, r.confidence]));
  if (saved.get(date) !== sig && rows.length) {
    await live.repo.upsertRecommendations(date, rows);
    saved.set(date, sig);
  }
  const plan = new Map((await live.repo.getPlan(date)).map((r) => [`${r.shopId}|${r.productId}`, r]));

  const pIdx = new Map(snap.products.map((p, i) => [p.id, i]));
  const menu = menuRows.map((m) => {
    const p = snap.products[pIdx.get(`K${m.productId}`) ?? -1];
    const cat = productCategory(live.ds, m.productId);
    return { productId: m.productId, name: p?.name ?? cat.name, categoryId: p?.categoryId ?? cat.id, source: m.source };
  });
  const fridges = snap.fridges.map((f) => ({ id: f.id, shopId: f.externalId, name: f.name, short: f.shortName ?? f.name }));
  const outCells = cells.map((c) => {
    const pr = plan.get(`${c.shopId}|${c.productId.replace(/^K/, "")}`);
    return { ...c, productId: c.productId.replace(/^K/, ""), manualQty: pr?.manualQty ?? null, manualBy: pr?.manualBy ?? null };
  });
  const finalQty = (c: (typeof outCells)[number]) => c.manualQty ?? c.qty ?? 0;
  const totals = Object.fromEntries(menu.map((m) => [m.productId, outCells.filter((c) => c.productId === m.productId).reduce((acc, c) => acc + finalQty(c), 0)]));
  const fridgeTotals = Object.fromEntries(fridges.map((f) => [f.shopId, outCells.filter((c) => c.shopId === f.shopId).reduce((acc, c) => acc + finalQty(c), 0)]));
  const analysisDay = cache ? dayNumber(cache.runAt) : null;
  const failed = new Set(snap.fridges.filter((_, f) => (snap.productDays?.checks[f] ?? []).some((c) => c.level === "FAIL")).map((f) => f.externalId));

  return {
    date,
    day,
    now: snap.now,
    status: {
      label: !cache ? "ИДЁТ ПЕРВЫЙ РАСЧЁТ" : analysisDay === dayNumber(snap.now) ? "ГОТОВО" : "РАСЧЁТ ВЧЕРАШНИЙ",
      analysisAt: cache?.runAt ?? null,
      fridgesWithFailedChecks: [...failed],
    },
    menu,
    fridges,
    cells: outCells,
    totals,
    fridgeTotals,
    grandTotal: Object.values(totals).reduce((acc, x) => acc + x, 0),
  };
}

export type TomorrowView = Awaited<ReturnType<typeof tomorrowView>>;

/** Food products of the catalog (to add dishes to the menu). */
export function menuCatalog(live: KitShopLive) {
  return [...live.ds.products.values()]
    .filter((p) => isFood(p.name, p.price))
    .map((p) => ({ productId: p.productId, name: p.name.replace(/\s+/g, " ").trim(), categoryId: productCategory(live.ds, p.productId).id }))
    .sort((x, y) => x.name.localeCompare(y.name, "ru"));
}

const norm = (s: string) => s.toLowerCase().replace(/[«»"“”'`]/g, "").replace(/\s+/g, " ").trim();

/**
 * Menu from the Google Sheets table (READ ONLY — the public CSV query endpoint, nothing is written): every row whose
 * first non-empty cell is a dish name (or a ProductId) of our catalog. Unknown names are returned, never guessed.
 */
export async function menuFromSheet(live: KitShopLive, tab: string, fetcher: (url: string) => Promise<string> = defaultFetch) {
  const id = sheetId();
  if (!id) throw new Error("Таблица не подключена: на сервере нужна переменная GOOGLE_SHEET_ID");
  const url = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  const rows = parseCsv(await fetcher(url));
  const byName = new Map(menuCatalog(live).map((p) => [norm(p.name), p.productId]));
  const matched = new Map<string, string>();
  const unmatched: string[] = [];
  for (const r of rows.slice(1)) {
    const cell = r.find((x) => x.trim() !== "");
    if (!cell) continue;
    const v = cell.trim();
    if (/^\d{4,}$/.test(v) && live.ds.products.has(v)) matched.set(v, live.ds.products.get(v)!.name);
    else if (byName.has(norm(v))) matched.set(byName.get(norm(v))!, v);
    else if (v.length > 2 && !/^[\d\s.,%-]+$/.test(v)) unmatched.push(v);
  }
  return { matched: [...matched].map(([productId, name]) => ({ productId, name })), unmatched: [...new Set(unmatched)].slice(0, 50) };
}

async function defaultFetch(url: string) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`Google Sheets ответил ${res.status}`);
    const text = await res.text();
    if (/^\s*</.test(text)) throw new Error("таблица или лист не открыты по ссылке");
    return text;
  } finally {
    clearTimeout(t);
  }
}
