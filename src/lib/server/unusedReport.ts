import "server-only";
import { KitShopReadOnlyClient } from "@/services/kitshop/kitshopClient";
import { parseKitshopDate } from "@/services/kitshop/transport";
import {
  analyzeNames,
  buildUnusedProductsXlsx,
  sanityCheck,
  type DataCompleteness,
  type EndpointLog,
  type FillUpRecord,
  type ReportInput,
  type ReportProduct,
  type SalesWindow,
} from "../reports/unusedProducts";
import { analyzeByShop, sanityCheckShops, shopHowRows, shopSheets, shopSummaries, type ShopInfo, type ShopReportInput, type ShopSales } from "../reports/unusedByShop";
import { wallClockNow } from "../time";
import { kitshopLiveStarted } from "./kitshopLive";
import { kitshopServerInfo, kitshopTransport } from "./kitshopWrite";
import { loadReport, saveReport } from "./reportStore";
import { HttpError } from "./runtime";

/**
 * Background job: a FRESH read-only pass over the real KiT Shop → conservative "what can be deleted" Excel.
 * Calls: GetProducts, GetSalesByProducts (13 × 14 days), GetShops + GetShopStocks (every shop),
 * GetFillUps (60 days) + GetFillUpById for every fill-up. Never a write, never simulator data, never an old Excel.
 * A failing endpoint does not stop the job: it is logged and the affected decisions are downgraded (no "УДАЛИТЬ").
 *
 * The finished file is stored in OUR database (report_files) — a sleeping / restarted server still serves the last one.
 * The server rebuilds it by itself once a day (UNUSED_REPORT_AUTO, default on; UNUSED_REPORT_EVERY_HOURS, default 24),
 * so nobody has to remember to press the button or wait 10–25 minutes.
 */

const DAY = 86_400_000;
const WINDOWS = 13; // 13 × 14 days ≈ 6 months
const FILLUP_DAYS = 60; // API limit for one GetFillUps period
const MAX_FILLUP_DETAILS = 6000; // above that the read is incomplete → no "УДАЛИТЬ"

interface Summary {
  delete: number;
  check: number;
  fresh: number;
  keep: number;
  total: number;
  dataReadAt: number;
  endpoints: EndpointLog[];
  complete: DataCompleteness;
  /** per point (each fridge has its own product base) */
  shops?: { removeTotal: number; checkTotal: number; shops: number; basesRead: number; salesComplete: boolean; salesFrom: number | null };
}

interface JobState {
  status: "idle" | "running" | "done" | "error";
  startedAt: number | null;
  finishedAt: number | null;
  startedBy: string | null;
  step: string;
  progress: number;
  error: string | null;
  file: Uint8Array | null;
  fileName: string | null;
  summary: Summary | null;
  /** last finished report (memory or database) — stays downloadable while a new one is being built */
  last: { name: string; data: Uint8Array; summary: Summary | null; finishedAt: number; startedBy: string | null } | null;
  lastLoaded: boolean;
  lastAutoAttempt: number | null;
}

const g = globalThis as unknown as { __unusedReport?: JobState };
const job = (): JobState =>
  (g.__unusedReport ??= {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    startedBy: null,
    step: "",
    progress: 0,
    error: null,
    file: null,
    fileName: null,
    summary: null,
    last: null,
    lastLoaded: false,
    lastAutoAttempt: null,
  });

const AUTO = () => process.env.UNUSED_REPORT_AUTO !== "false";
const EVERY_MS = () => Math.max(1, Number(process.env.UNUSED_REPORT_EVERY_HOURS) || 24) * 3_600_000;

async function loadLast(j: JobState) {
  if (j.lastLoaded) return;
  j.lastLoaded = true;
  const r = await loadReport();
  if (r && (!j.last || r.finishedAt > j.last.finishedAt)) j.last = { ...r, summary: (r.summary as Summary | null) ?? null };
}

export async function reportStatus() {
  const j = job();
  await loadLast(j);
  const nextAutoAt = AUTO() && readBlocked() === null ? (j.last ? j.last.finishedAt + EVERY_MS() : Date.now()) : null;
  return {
    status: j.status,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    startedBy: j.startedBy,
    step: j.step,
    progress: j.progress,
    error: j.error,
    // the summary shown is the one of the downloadable file
    summary: j.last?.summary ?? null,
    ready: !!j.last,
    last: j.last ? { name: j.last.name, finishedAt: j.last.finishedAt, startedBy: j.last.startedBy } : null,
    auto: { on: AUTO(), everyHours: EVERY_MS() / 3_600_000, nextAt: nextAutoAt },
  };
}

export async function reportFile(): Promise<{ data: Uint8Array; name: string } | null> {
  const j = job();
  await loadLast(j);
  return j.last ? { data: j.last.data, name: j.last.name } : null;
}

function readBlocked(): string | null {
  const s = kitshopServerInfo();
  if (process.env.KITSHOP_REAL_DIAGNOSTICS !== "true" && !s.config.enabled) return "Чтение KiT Shop выключено: нужен KITSHOP_REAL_DIAGNOSTICS=true (только чтение) в настройках сервера";
  if (!s.config.companyId || !s.config.login || !s.config.password) return "Не заданы KITSHOP_COMPANY_ID / KITSHOP_LOGIN / KITSHOP_PASSWORD";
  return null;
}

/**
 * Called by the server every minute and by /api/health: rebuilds the report when the last one is older than
 * UNUSED_REPORT_EVERY_HOURS. A failed attempt is retried after 6 hours, not in a loop.
 */
export async function autoUnusedReport(): Promise<void> {
  if (!AUTO() || readBlocked() !== null) return;
  const j = job();
  if (j.status === "running") return;
  await loadLast(j);
  const now = Date.now();
  if (j.last && now - j.last.finishedAt < EVERY_MS()) return;
  if (j.lastAutoAttempt && now - j.lastAutoAttempt < 6 * 3_600_000) return;
  j.lastAutoAttempt = now;
  console.info("[apps-holodosov] unused products report: automatic rebuild");
  await startUnusedReport("авто (раз в сутки)");
}

export async function startUnusedReport(user: string) {
  const blocked = readBlocked();
  if (blocked) throw new HttpError(409, blocked);
  const j = job();
  if (j.status === "running") return reportStatus();
  // the previous file stays downloadable (with its own date) until the new one is finished and checked
  Object.assign(j, { status: "running", startedAt: Date.now(), finishedAt: null, startedBy: user, step: "старт", progress: 0, error: null, summary: null, file: null, fileName: null });
  void run(j).catch((e) => {
    j.status = "error";
    j.error = e instanceof Error ? e.message : String(e);
    j.finishedAt = Date.now();
    console.error("[apps-holodosov] unused products report failed:", j.error);
  });
  return reportStatus();
}

async function run(j: JobState) {
  const s = kitshopServerInfo();
  const reader = new KitShopReadOnlyClient({ ...s.config, enabled: true }, kitshopTransport());
  const tz = process.env.APP_TIMEZONE || "Asia/Almaty";
  const now = wallClockNow(tz);
  const set = (step: string, progress: number) => Object.assign(j, { step, progress });
  const endpoints = new Map<string, EndpointLog>();
  const log = (endpoint: string, ok: boolean, note = "") => {
    const e = endpoints.get(endpoint) ?? { endpoint, ok: 0, failed: 0, note: "" };
    if (ok) e.ok++;
    else {
      e.failed++;
      if (note && !e.note) e.note = note;
    }
    endpoints.set(endpoint, e);
  };
  const tryRead = async <T>(endpoint: string, f: () => Promise<T>): Promise<T | null> => {
    try {
      const v = await f();
      log(endpoint, true);
      return v;
    } catch (e) {
      log(endpoint, false, e instanceof Error ? e.message.slice(0, 160) : "ошибка");
      return null;
    }
  };
  const complete: DataCompleteness = { products: true, sales: true, stocks: true, fillUps: true };

  set("каталог товаров (GetProducts)", 2);
  const catalog = await tryRead("GetProducts", () => reader.getProducts());
  if (!catalog) throw new Error("Каталог товаров KiT Shop не загрузился — отчёт без каталога не строится");
  const products: ReportProduct[] = catalog.map((p) => ({ productId: p.ProductId, name: p.ProductName, barcode: p.Barcode ?? null, vendorCode: p.VendorCode ?? null, price: p.Price ?? null }));

  const salesWindows: SalesWindow[] = [];
  for (let i = 0; i < WINDOWS; i++) {
    set(`продажи по товарам: период ${i + 1} из ${WINDOWS}`, 4 + Math.round((i / WINDOWS) * 16));
    const to = now - i * 14 * DAY;
    const from = to - 14 * DAY + 1000;
    const rows = await tryRead("GetSalesByProducts", () => reader.getSalesByProducts({ from, to }));
    if (!rows) {
      complete.sales = false;
      salesWindows.push({ from, to, qty: new Map() });
      continue;
    }
    const qty = new Map<string, number>();
    for (const r of rows) qty.set(r.ProductId, (qty.get(r.ProductId) ?? 0) + r.Quantity);
    salesWindows.push({ from, to, qty });
    for (const r of rows) if (!products.some((p) => p.productId === r.ProductId)) products.push({ productId: r.ProductId, name: r.ProductName ?? `#${r.ProductId}`, barcode: null, vendorCode: null, price: r.Price ?? null });
  }

  set("торговые точки (GetShops)", 21);
  const shops = (await tryRead("GetShops", () => reader.getShops())) ?? [];
  if (!shops.length) complete.stocks = false;
  const stocks = new Map<string, { qty: number; shops: number }>();
  const stockByShop = new Map<string, Map<string, number>>();
  const stockFailedShops = new Set<string>();
  for (const [i, shop] of shops.entries()) {
    set(`остатки: ${shop.ShopName} (${i + 1} из ${shops.length})`, 22 + Math.round((i / Math.max(1, shops.length)) * 8));
    const rows = await tryRead("GetShopStocks", () => reader.getShopStocks(shop.ShopId));
    if (!rows) {
      complete.stocks = false;
      stockFailedShops.add(shop.ShopId);
      continue;
    }
    const mine = new Map<string, number>();
    stockByShop.set(shop.ShopId, mine);
    for (const st of rows) {
      if (st.Quantity <= 0) continue;
      mine.set(st.ProductId, (mine.get(st.ProductId) ?? 0) + st.Quantity);
      const cur = stocks.get(st.ProductId) ?? { qty: 0, shops: 0 };
      stocks.set(st.ProductId, { qty: cur.qty + st.Quantity, shops: cur.shops + 1 });
    }
  }

  set(`загрузки и снятия за ${FILLUP_DAYS} дней (GetFillUps)`, 31);
  const listRaw = await tryRead("GetFillUps", () => reader.getFillUps({ from: now - FILLUP_DAYS * DAY + 1000, to: now }));
  if (!listRaw) complete.fillUps = false;
  const list = (listRaw ?? []).map((f) => ({ f, at: f.FillupDateTime ? parseKitshopDate(f.FillupDateTime) : null })).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  if (list.length > MAX_FILLUP_DETAILS) complete.fillUps = false;
  const fillUps: FillUpRecord[] = [];
  const detailed = list.slice(0, MAX_FILLUP_DETAILS);
  for (const [i, { f, at }] of detailed.entries()) {
    if (i % 10 === 0) set(`состав загрузок/снятий: ${i + 1} из ${detailed.length}`, 32 + Math.round((i / Math.max(1, detailed.length)) * 64));
    const d = await tryRead("GetFillUpById", () => reader.getFillUpById(f.FillupId));
    if (!d) {
      complete.fillUps = false;
      continue;
    }
    fillUps.push({ at, type: f.FillupType ?? null, notes: d.Notes ?? f.Notes ?? null, shopId: f.ShopId, lines: (d.Details ?? []).map((x) => ({ productId: x.ProductId, qty: x.Quantity })) });
  }
  // product base of every point (§3.32) — read only; a template may be shared by several points
  set("базы товаров точек (GetProductBaseTemplate)", 96);
  const shopInfos: ShopInfo[] = shops.map((sh) => ({ shopId: sh.ShopId, name: sh.ShopName, templateId: typeof sh.ProductBaseTemplateId === "number" ? sh.ProductBaseTemplateId : null }));
  const bases: ShopReportInput["bases"] = new Map();
  for (const t of new Set(shopInfos.map((x) => x.templateId).filter((x): x is number => x !== null))) {
    const b = await tryRead("GetProductBaseTemplate", () => reader.getProductBaseTemplate(t));
    bases.set(t, b ?? null);
    if (b === null) log("GetProductBaseTemplate", false, "ответ без списка товаров (формат не описан в документации)");
  }
  if (!shopInfos.some((x) => x.templateId !== null)) log("GetProductBaseTemplate", false, "GetShops не вернул ProductBaseTemplateId — базы точек не прочитаны");

  // sales per point: receipts with product lines kept by the read-only sync (GetSales + GetSaleById)
  let shopSales: ShopSales | null = null;
  const live = kitshopLiveStarted();
  if (live) {
    await live.ready();
    const ds = live.ds;
    const from60 = now - 60 * DAY;
    // the history is read from the database per shop × dish (it is not kept in memory)
    const history = live.repo.history(ds);
    const st = await live.repo.stats(ds, now - 30 * 60_000);
    const undetailedRecent = st.newestUndetailedSale !== null && st.newestUndetailedSale >= from60;
    const byShop: ShopSales["byShop"] = new Map();
    const qty60 = new Map((await history.salesByShopProduct(from60, now)).map((r) => [`${r.shopId}|${r.productId}`, r.qty]));
    for (const r of await history.salesByShopProduct(0, now)) {
      const m = byShop.get(r.shopId) ?? new Map();
      m.set(r.productId, { last: r.last, qty60: qty60.get(`${r.shopId}|${r.productId}`) ?? 0, qtyAll: r.qty });
      byShop.set(r.shopId, m);
    }
    const coveredFrom = ds.state.backfillFrom;
    shopSales = { coveredFrom, complete60: coveredFrom !== null && coveredFrom <= from60 && !undetailedRecent, byShop };
  }
  const dataReadAt = wallClockNow(tz);

  set("решения и проверка перед выдачей", 97);
  const realHost = new URL(s.config.baseUrl).hostname === "api.kitshop.ru";
  const input: ReportInput = {
    generatedAt: now,
    dataReadAt,
    products,
    salesWindows,
    stocks,
    shopsChecked: shops.length,
    fillUps,
    fillUpDays: FILLUP_DAYS,
    fillUpsTotal: list.length,
    complete,
    endpoints: [...endpoints.values()],
    environment: `${process.env.RENDER === "true" ? "Render production" : "local"} · ${realHost ? "KiT Shop REAL (api.kitshop.ru)" : "ВНИМАНИЕ: не api.kitshop.ru"}`,
  };
  const rows = analyzeNames(input);
  const errors = sanityCheck(rows);
  if (errors.length) throw new Error(`Проверка перед выдачей не пройдена — файл не создан: ${errors.slice(0, 3).join("; ")}`);
  const shopInput: ShopReportInput = {
    generatedAt: now,
    shops: shopInfos,
    bases,
    products,
    shopSales,
    fillUps,
    fillUpsComplete: complete.fillUps,
    fillUpDays: FILLUP_DAYS,
    stockByShop,
    stockFailedShops,
    nameRows: rows,
  };
  const shopRows = analyzeByShop(shopInput);
  const shopErrors = sanityCheckShops(shopRows, shopInput);
  if (shopErrors.length) throw new Error(`Проверка по точкам не пройдена — файл не создан: ${shopErrors.slice(0, 3).join("; ")}`);
  const summaries = shopSummaries(shopRows, shopInput);
  const d = new Date(now);
  const p2 = (n: number) => String(n).padStart(2, "0");
  j.file = buildUnusedProductsXlsx(input, rows, { before: shopSheets(shopRows, summaries), howExtra: shopHowRows(shopInput) });
  j.fileName = `chto-udalit-iz-kitshop-${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}.xlsx`;
  const c = (st: string[]) => rows.filter((r) => st.includes(r.status)).length;
  j.summary = {
    delete: c(["УДАЛИТЬ"]),
    check: c(["МОЖНО ПРОВЕРИТЬ", "НЕ ХВАТАЕТ ДАННЫХ"]),
    fresh: c(["НОВЫЙ"]),
    keep: c(["ОСТАВИТЬ"]),
    total: rows.length,
    dataReadAt,
    endpoints: input.endpoints,
    complete,
    shops: {
      removeTotal: summaries.reduce((a, x) => a + x.remove, 0),
      checkTotal: summaries.reduce((a, x) => a + x.check, 0),
      shops: summaries.length,
      basesRead: summaries.filter((x) => x.baseRead).length,
      salesComplete: !!shopSales?.complete60,
      salesFrom: shopSales?.coveredFrom ?? null,
    },
  };
  j.finishedAt = Date.now();
  j.last = { name: j.fileName, data: j.file, summary: j.summary, finishedAt: j.finishedAt, startedBy: j.startedBy };
  await saveReport({ name: j.fileName, data: j.file, summary: j.summary, finishedAt: j.finishedAt, startedBy: j.startedBy }).catch((e) =>
    console.error("[apps-holodosov] could not store the report in the database:", e instanceof Error ? e.message : e),
  );
  j.status = "done";
  j.progress = 100;
  j.step = "готово";
}
