import "server-only";
import { KitShopReadOnlyClient } from "@/services/kitshop/kitshopClient";
import { parseKitshopDate } from "@/services/kitshop/transport";
import { analyzeProducts, buildUnusedProductsXlsx, type FillUpRecord, type ReportInput, type SalesWindow } from "../reports/unusedProducts";
import { wallClockNow } from "../time";
import { kitshopServerInfo, kitshopTransport } from "./kitshopWrite";
import { HttpError } from "./runtime";

/**
 * Background job: collects REAL KiT Shop data (read-only) and builds the "unused dishes" Excel for managers.
 * Calls: GetProducts, GetSalesByProducts (13 × 14 days), GetShops + GetShopStocks, GetFillUps (30 days) + GetFillUpById.
 * Never a write. Never simulator data.
 */

const DAY = 86_400_000;
const WINDOWS = 13; // 13 × 14 days ≈ 6 months
const FILLUP_DAYS = 30;
const MAX_FILLUP_DETAILS = 600;

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
  summary: { delete: number; check: number; keep: number; total: number } | null;
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
  Object.assign(j, { status: "running", startedAt: Date.now(), finishedAt: null, startedBy: user, step: "старт", progress: 0, error: null, summary: null });
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
  const now = wallClockNow(process.env.APP_TIMEZONE || "Asia/Almaty");
  const set = (step: string, progress: number) => Object.assign(j, { step, progress });

  set("каталог товаров (GetProducts)", 2);
  const products = (await reader.getProducts()).map((p) => ({
    productId: p.ProductId,
    name: p.ProductName,
    barcode: p.Barcode ?? null,
    vendorCode: p.VendorCode ?? null,
    price: p.Price ?? null,
  }));

  const salesWindows: SalesWindow[] = [];
  for (let i = 0; i < WINDOWS; i++) {
    set(`продажи по товарам: период ${i + 1} из ${WINDOWS}`, 5 + Math.round((i / WINDOWS) * 30));
    const to = now - i * 14 * DAY;
    const from = to - 14 * DAY + 1000;
    const rows = await reader.getSalesByProducts({ from, to });
    const qty = new Map<string, number>();
    for (const r of rows) qty.set(r.ProductId, (qty.get(r.ProductId) ?? 0) + r.Quantity);
    salesWindows.push({ from, to, qty });
    // products sold but missing from the catalog (deleted/renamed) still appear in the report
    for (const r of rows) if (!products.some((p) => p.productId === r.ProductId)) products.push({ productId: r.ProductId, name: r.ProductName ?? `#${r.ProductId}`, barcode: null, vendorCode: null, price: r.Price ?? null });
  }

  set("торговые точки (GetShops)", 36);
  const shops = await reader.getShops();
  const stocks = new Map<string, { qty: number; shops: number }>();
  for (const [i, shop] of shops.entries()) {
    set(`остатки: ${shop.ShopName} (${i + 1} из ${shops.length})`, 37 + Math.round((i / Math.max(1, shops.length)) * 18));
    for (const st of await reader.getShopStocks(shop.ShopId)) {
      if (st.Quantity <= 0) continue;
      const cur = stocks.get(st.ProductId) ?? { qty: 0, shops: 0 };
      stocks.set(st.ProductId, { qty: cur.qty + st.Quantity, shops: cur.shops + 1 });
    }
  }

  set(`загрузки и снятия за ${FILLUP_DAYS} дней (GetFillUps)`, 56);
  const list = (await reader.getFillUps({ from: now - FILLUP_DAYS * DAY, to: now }))
    .map((f) => ({ f, at: f.FillupDateTime ? parseKitshopDate(f.FillupDateTime) : null }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const detailed = list.slice(0, MAX_FILLUP_DETAILS);
  const fillUps: FillUpRecord[] = [];
  for (const [i, { f, at }] of detailed.entries()) {
    if (i % 10 === 0) set(`состав загрузок/снятий: ${i + 1} из ${detailed.length}`, 57 + Math.round((i / Math.max(1, detailed.length)) * 38));
    const d = await reader.getFillUpById(f.FillupId);
    fillUps.push({
      at,
      type: f.FillupType ?? null,
      notes: d?.Notes ?? f.Notes ?? null,
      shopId: f.ShopId,
      lines: (d?.Details ?? []).map((x) => ({ productId: x.ProductId, qty: x.Quantity })),
    });
  }

  set("формирую Excel", 97);
  const realHost = new URL(s.config.baseUrl).hostname === "api.kitshop.ru";
  const input: ReportInput = {
    generatedAt: now,
    products,
    salesWindows,
    stocks,
    shopsChecked: shops.length,
    fillUps,
    fillUpDays: FILLUP_DAYS,
    fillUpsTotal: list.length,
    fillUpsCapped: list.length > detailed.length,
    environment: `${process.env.RENDER === "true" ? "Render production" : "local"}${realHost ? "" : " · ВНИМАНИЕ: не api.kitshop.ru"}`,
  };
  const rows = analyzeProducts(input);
  const d = new Date(now);
  const p2 = (n: number) => String(n).padStart(2, "0");
  j.file = buildUnusedProductsXlsx(input, rows);
  j.fileName = `neispolzuemye-blyuda-${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}.xlsx`;
  j.summary = {
    delete: rows.filter((r) => r.recommendation === "УДАЛИТЬ").length,
    check: rows.filter((r) => r.recommendation === "ПРОВЕРИТЬ").length,
    keep: rows.filter((r) => r.recommendation === "ОСТАВИТЬ").length,
    total: rows.length,
  };
  j.status = "done";
  j.progress = 100;
  j.step = "готово";
  j.finishedAt = Date.now();
}
