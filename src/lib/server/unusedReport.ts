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
import { wallClockNow } from "../time";
import { kitshopServerInfo, kitshopTransport } from "./kitshopWrite";
import { HttpError } from "./runtime";

/**
 * Background job: a FRESH read-only pass over the real KiT Shop → conservative "what can be deleted" Excel.
 * Calls: GetProducts, GetSalesByProducts (13 × 14 days), GetShops + GetShopStocks (every shop),
 * GetFillUps (60 days) + GetFillUpById for every fill-up. Never a write, never simulator data, never an old Excel.
 * A failing endpoint does not stop the job: it is logged and the affected decisions are downgraded (no "УДАЛИТЬ").
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
}

const g = globalThis as unknown as { __unusedReport?: JobState };
const job = (): JobState =>
  (g.__unusedReport ??= { status: "idle", startedAt: null, finishedAt: null, startedBy: null, step: "", progress: 0, error: null, file: null, fileName: null, summary: null });

export function reportStatus() {
  const j = job();
  return { status: j.status, startedAt: j.startedAt, finishedAt: j.finishedAt, startedBy: j.startedBy, step: j.step, progress: j.progress, error: j.error, summary: j.summary, ready: !!j.file };
}

export function reportFile(): { data: Uint8Array; name: string } | null {
  const j = job();
  return j.file && j.fileName ? { data: j.file, name: j.fileName } : null;
}

export function startUnusedReport(user: string) {
  const s = kitshopServerInfo();
  if (process.env.KITSHOP_REAL_DIAGNOSTICS !== "true" && !s.config.enabled)
    throw new HttpError(409, "Чтение KiT Shop выключено: нужен KITSHOP_REAL_DIAGNOSTICS=true (только чтение) в настройках сервера");
  if (!s.config.companyId || !s.config.login || !s.config.password) throw new HttpError(409, "Не заданы KITSHOP_COMPANY_ID / KITSHOP_LOGIN / KITSHOP_PASSWORD");
  const j = job();
  if (j.status === "running") return reportStatus();
  // a previous file is never served as fresh: drop it before the new read
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
  for (const [i, shop] of shops.entries()) {
    set(`остатки: ${shop.ShopName} (${i + 1} из ${shops.length})`, 22 + Math.round((i / Math.max(1, shops.length)) * 8));
    const rows = await tryRead("GetShopStocks", () => reader.getShopStocks(shop.ShopId));
    if (!rows) {
      complete.stocks = false;
      continue;
    }
    for (const st of rows) {
      if (st.Quantity <= 0) continue;
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
  const d = new Date(now);
  const p2 = (n: number) => String(n).padStart(2, "0");
  j.file = buildUnusedProductsXlsx(input, rows);
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
  };
  j.status = "done";
  j.progress = 100;
  j.step = "готово";
  j.finishedAt = Date.now();
}
