import type { CellValue, Sheet } from "./xlsx";
import { normalizeName, type FillUpRecord, type NameRow, type ReportProduct } from "./unusedProducts";

/**
 * "Что убрать из базы КАЖДОГО холодильника" — per-shop part of the conservative report.
 * In KiT Shop every point has its own product base (template, §3.32): products are added to and removed from each
 * fridge separately. A dish that sells in Каблан can still be dead weight in the base of Шарипова.
 *
 * «УБРАТЬ ИЗ ТОЧКИ» only when, IN THIS POINT: no sales for 60 days, no loads / removals for 60 days, stock 0,
 * the card is not new (company-wide), and every data source for this point loaded completely.
 * Removing from one point's base never means deleting the card: other points may still sell it.
 */

export type ShopStatus = "УБРАТЬ ИЗ ТОЧКИ" | "ПРОВЕРИТЬ" | "ОСТАВИТЬ" | "НОВЫЙ";

export interface ShopInfo {
  shopId: string;
  name: string;
  templateId: number | null;
}

export interface ShopSales {
  /** oldest wall-clock ms covered by the receipt cache */
  coveredFrom: number | null;
  /** every receipt of the last 60 days is known with its product lines */
  complete60: boolean;
  /** shopId → productId → sales */
  byShop: Map<string, Map<string, { last: number; qty60: number; qtyAll: number }>>;
}

export interface ShopReportInput {
  generatedAt: number;
  shops: ShopInfo[];
  /** product base per template id; null = read failed / unknown reply format */
  bases: Map<number, { productId: string; disabled: boolean | null }[] | null>;
  products: ReportProduct[];
  /** null = per-point sales are not available (receipt sync not running) */
  shopSales: ShopSales | null;
  fillUps: FillUpRecord[];
  fillUpsComplete: boolean;
  fillUpDays: number;
  /** shopId → productId → qty > 0 */
  stockByShop: Map<string, Map<string, number>>;
  stockFailedShops: Set<string>;
  /** company-wide decisions (НОВЫЙ guard, network sales) */
  nameRows: NameRow[];
}

export interface ShopRow {
  shopId: string;
  shopName: string;
  productId: string;
  name: string;
  status: ShopStatus;
  why: string;
  lastSaleHere: number | null;
  sold60Here: number;
  lastLoadHere: number | null;
  loaded60Here: number;
  removed60Here: number;
  stockHere: number;
  sold60Network: number;
  /** true = listed in the point's product base; null = the base could not be read */
  inBase: boolean | null;
  disabledInBase: boolean | null;
}

export interface ShopSummary {
  shopId: string;
  name: string;
  baseRead: boolean;
  baseSize: number | null;
  remove: number;
  check: number;
  keep: number;
  fresh: number;
}

const DAY = 86_400_000;
const WINDOW_DAYS = 60;

const fmt = (ms: number | null) => {
  if (ms === null) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
};

export function analyzeByShop(input: ShopReportInput): ShopRow[] {
  const now = input.generatedAt;
  const cutoff = now - WINDOW_DAYS * DAY;
  const fillCutoff = now - input.fillUpDays * DAY;
  const productName = new Map(input.products.map((p) => [p.productId, p.name.replace(/\s+/g, " ").trim()]));
  // company-wide: status of the NAME (one new card keeps the name) and network sales per card
  const nameStatus = new Map(input.nameRows.map((r) => [normalizeName(r.name), r.status]));
  const network = new Map<string, { sold60: number; isNew: boolean }>();
  for (const r of input.nameRows) for (const c of r.cards) network.set(c.product.productId, { sold60: c.sold60, isNew: c.status === "НОВЫЙ" });

  // loads / removals per shop
  const fills = new Map<string, Map<string, { loaded: number; removed: number; last: number | null }>>();
  for (const f of input.fillUps) {
    if (f.at !== null && f.at < fillCutoff) continue;
    const m = fills.get(f.shopId) ?? new Map();
    for (const l of f.lines) {
      const cur = m.get(l.productId) ?? { loaded: 0, removed: 0, last: null };
      if (l.qty > 0) cur.loaded += l.qty;
      else if (l.qty < 0) cur.removed -= l.qty;
      if (f.at !== null && (cur.last === null || f.at > cur.last)) cur.last = f.at;
      m.set(l.productId, cur);
    }
    fills.set(f.shopId, m);
  }

  const rows: ShopRow[] = [];
  for (const shop of input.shops) {
    const base = shop.templateId !== null ? input.bases.get(shop.templateId) : undefined;
    const baseKnown = Array.isArray(base);
    const sales = input.shopSales?.byShop.get(shop.shopId) ?? new Map();
    const stock = input.stockByShop.get(shop.shopId) ?? new Map<string, number>();
    const fill = fills.get(shop.shopId) ?? new Map();

    // candidates: the point's base; without it — every product that left a trace in this point
    const disabled = new Map<string, boolean | null>();
    let candidates: string[];
    if (baseKnown) {
      for (const b of base!) disabled.set(b.productId, b.disabled);
      candidates = [...new Set(base!.map((b) => b.productId))];
    } else candidates = [...new Set([...sales.keys(), ...stock.keys(), ...fill.keys()])];

    for (const pid of candidates) {
      const name = productName.get(pid) ?? `Товар #${pid}`;
      const s = sales.get(pid);
      const f = fill.get(pid);
      const st = stock.get(pid) ?? 0;
      const net = network.get(pid) ?? { sold60: 0, isNew: false };
      const row: ShopRow = {
        shopId: shop.shopId,
        shopName: shop.name,
        productId: pid,
        name,
        status: "ПРОВЕРИТЬ",
        why: "",
        lastSaleHere: s?.last ?? null,
        sold60Here: s?.qty60 ?? 0,
        lastLoadHere: f?.last ?? null,
        loaded60Here: f?.loaded ?? 0,
        removed60Here: f?.removed ?? 0,
        stockHere: st,
        sold60Network: net.sold60,
        inBase: baseKnown ? true : null,
        disabledInBase: disabled.get(pid) ?? null,
      };
      const elsewhere = net.sold60 > 0 ? ` В других точках продаётся (${net.sold60} шт. за 60 дн.) — убрать только из этой точки, карточку не удалять.` : "";
      if (st > 0) Object.assign(row, { status: "ОСТАВИТЬ", why: `Лежит в этом холодильнике: ${st} шт.` });
      else if (row.sold60Here > 0) Object.assign(row, { status: "ОСТАВИТЬ", why: `Продажи здесь за 60 дней: ${row.sold60Here} шт. (последняя ${fmt(row.lastSaleHere)}).` });
      else if (row.loaded60Here > 0 || row.removed60Here > 0)
        Object.assign(row, { status: "ОСТАВИТЬ", why: `Загрузки/снятия здесь за ${input.fillUpDays} дней: +${row.loaded60Here} / −${row.removed60Here} шт. (последняя ${fmt(row.lastLoadHere)}).` });
      else if (net.isNew || nameStatus.get(normalizeName(name)) === "НОВЫЙ")
        Object.assign(row, { status: "НОВЫЙ", why: "Блюдо новое (меньше 60 дней в KiT Shop) — не убирать, пока не накопится история." });
      else {
        const missing: string[] = [];
        if (!input.shopSales) missing.push("продажи по точкам ещё не загружены (нужна синхронизация чеков)");
        else if (!input.shopSales.complete60) missing.push("история чеков по точкам меньше 60 дней или ещё догружается");
        if (!input.fillUpsComplete) missing.push("загрузки/снятия прочитаны не полностью");
        if (input.stockFailedShops.has(shop.shopId)) missing.push("остаток этой точки не прочитался");
        const lastText = row.lastSaleHere !== null ? `последняя продажа здесь ${fmt(row.lastSaleHere)}` : "за весь период наблюдения здесь не продавался";
        if (missing.length) Object.assign(row, { status: "ПРОВЕРИТЬ", why: `Здесь за 60 дней нет продаж, загрузок и остатка, но ${missing.join("; ")}. ${lastText}.${elsewhere}` });
        else
          Object.assign(row, {
            status: "УБРАТЬ ИЗ ТОЧКИ",
            why: `В этой точке за 60 дней: продаж 0, загрузок 0, снятий 0, остаток 0; ${lastText}.${elsewhere}`,
          });
      }
      rows.push(row);
    }
  }
  const order: Record<ShopStatus, number> = { "УБРАТЬ ИЗ ТОЧКИ": 0, ПРОВЕРИТЬ: 1, НОВЫЙ: 2, ОСТАВИТЬ: 3 };
  return rows.sort((a, b) => a.shopName.localeCompare(b.shopName, "ru", { numeric: true }) || order[a.status] - order[b.status] || a.name.localeCompare(b.name, "ru"));
}

/** Any violation is a bug → no file. */
export function sanityCheckShops(rows: ShopRow[], input: ShopReportInput): string[] {
  const errors: string[] = [];
  for (const r of rows.filter((x) => x.status === "УБРАТЬ ИЗ ТОЧКИ")) {
    if (r.stockHere > 0) errors.push(`${r.shopName} / ${r.name}: есть остаток`);
    if (r.sold60Here > 0) errors.push(`${r.shopName} / ${r.name}: есть продажи за 60 дней`);
    if (r.loaded60Here > 0 || r.removed60Here > 0) errors.push(`${r.shopName} / ${r.name}: есть загрузки/снятия`);
    if (!input.shopSales?.complete60 || !input.fillUpsComplete || input.stockFailedShops.has(r.shopId)) errors.push(`${r.shopName} / ${r.name}: данные неполные`);
  }
  return errors;
}

export function shopSummaries(rows: ShopRow[], input: ShopReportInput): ShopSummary[] {
  return input.shops.map((s) => {
    const mine = rows.filter((r) => r.shopId === s.shopId);
    const base = s.templateId !== null ? input.bases.get(s.templateId) : undefined;
    const c = (st: ShopStatus) => mine.filter((r) => r.status === st).length;
    return {
      shopId: s.shopId,
      name: s.name,
      baseRead: Array.isArray(base),
      baseSize: Array.isArray(base) ? base.length : null,
      remove: c("УБРАТЬ ИЗ ТОЧКИ"),
      check: c("ПРОВЕРИТЬ"),
      keep: c("ОСТАВИТЬ"),
      fresh: c("НОВЫЙ"),
    };
  });
}

export const SHOP_HEADER = [
  "Точка",
  "ShopId",
  "Название блюда",
  "Решение",
  "Почему",
  "Последняя продажа здесь",
  "Продано здесь за 60 дн.",
  "Последняя загрузка здесь",
  "Остаток здесь",
  "Продано по сети за 60 дн.",
  "Есть в базе точки",
  "ProductId",
];
export const SHOP_WIDTHS = [28, 10, 42, 18, 80, 14, 12, 14, 10, 12, 12, 14];

export const shopCells = (r: ShopRow): CellValue[] => [
  r.shopName,
  r.shopId,
  r.name,
  r.status,
  r.why,
  fmt(r.lastSaleHere) || "нет",
  r.sold60Here,
  fmt(r.lastLoadHere),
  r.stockHere,
  r.sold60Network,
  r.inBase === null ? "база не прочитана" : r.disabledInBase ? "да (выключен)" : "да",
  r.productId,
];

/** Excel sheet names: ≤ 31 chars, no : \ / ? * [ ], unique. */
export function sheetName(raw: string, used: Set<string>): string {
  const base = raw.replace(/[:\\/?*[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 28) || "Точка";
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 26)} ${i}`;
  used.add(name.toLowerCase());
  return name;
}

/** Sheets that go FIRST in the Excel: summary, every «убрать» row, then one sheet per point. */
export function shopSheets(rows: ShopRow[], summaries: ShopSummary[]): Sheet[] {
  const used = new Set(["сводка по точкам", "убрать по точкам", "проверить по точкам"]);
  const summaryRows: CellValue[][] = [
    ["Точка", "ShopId", "База точки прочитана", "Позиций в базе", "УБРАТЬ ИЗ ТОЧКИ", "ПРОВЕРИТЬ", "НОВЫЕ", "ОСТАВИТЬ"],
    ...summaries.map((s): CellValue[] => [s.name, s.shopId, s.baseRead ? "да" : "нет", s.baseSize ?? "", s.remove, s.check, s.fresh, s.keep]),
  ];
  return [
    { name: "СВОДКА ПО ТОЧКАМ", rows: summaryRows, widths: [30, 10, 14, 12, 14, 12, 10, 10] },
    { name: "УБРАТЬ ПО ТОЧКАМ", rows: [SHOP_HEADER, ...rows.filter((r) => r.status === "УБРАТЬ ИЗ ТОЧКИ").map(shopCells)], widths: SHOP_WIDTHS },
    { name: "ПРОВЕРИТЬ ПО ТОЧКАМ", rows: [SHOP_HEADER, ...rows.filter((r) => r.status === "ПРОВЕРИТЬ").map(shopCells)], widths: SHOP_WIDTHS },
    ...summaries.map((s) => ({
      name: sheetName(s.name, used),
      rows: [SHOP_HEADER, ...rows.filter((r) => r.shopId === s.shopId && (r.status === "УБРАТЬ ИЗ ТОЧКИ" || r.status === "ПРОВЕРИТЬ")).map(shopCells)],
      widths: SHOP_WIDTHS,
    })),
  ];
}

export function shopHowRows(input: ShopReportInput): CellValue[][] {
  const sales = input.shopSales;
  return [
    [""],
    ["По каждой точке"],
    ["Почему отдельно", "В KiT Shop у каждой точки своя база товаров: блюда добавляются и убираются в каждом холодильнике отдельно. Блюдо может продаваться в одной точке и лежать мёртвым грузом в базе другой."],
    ["УБРАТЬ ИЗ ТОЧКИ", "В этой точке за 60 дней: продаж 0, загрузок 0, снятий 0, остаток 0; блюдо не новое; все данные по точке прочитаны полностью. Это значит убрать из базы этой точки, а не удалять карточку из KiT Shop."],
    ["ПРОВЕРИТЬ", "Активности в точке нет, но данных недостаточно для уверенного решения (история чеков по точкам меньше 60 дней, загрузки или остаток прочитаны не полностью)."],
    ["База точки", "GetProductBaseTemplate (§3.32) по ProductBaseTemplateId точки. Если база не прочиталась, в список попадают только блюда, которые когда-то были в этой точке (продажи, загрузки, остаток)."],
    [
      "Продажи по точкам",
      sales
        ? `Из чеков KiT Shop (GetSales + GetSaleById), сохранённых синхронизацией, с ${fmt(sales.coveredFrom)}; последние 60 дней ${sales.complete60 ? "полные" : "ЕЩЁ НЕ ПОЛНЫЕ — «убрать» не выдаётся"}.`
        : "Не загружены: включите синхронизацию чеков (DATA_SOURCE=kitshop_shadow). Пока это не сделано, «убрать» по точкам не выдаётся.",
    ],
  ];
}
