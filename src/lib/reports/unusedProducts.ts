import { buildXlsx, type CellValue } from "./xlsx";

/**
 * "Неиспользуемые блюда" — report for managers, built ONLY from real KiT Shop data (read-only methods).
 * Pure: the server collects the data, this module decides and formats. Nothing is deleted automatically.
 */

export interface ReportProduct {
  productId: string;
  name: string;
  barcode: string | null;
  vendorCode: string | null;
  price: number | null;
}

export interface SalesWindow {
  /** wall-clock ms (Almaty) */
  from: number;
  to: number;
  /** ProductId → quantity sold (company-wide) */
  qty: Map<string, number>;
}

export interface FillUpRecord {
  at: number | null;
  type: number | null;
  notes: string | null;
  shopId: string;
  lines: { productId: string; qty: number }[];
}

export interface ReportInput {
  generatedAt: number;
  products: ReportProduct[];
  /** newest first, contiguous */
  salesWindows: SalesWindow[];
  /** ProductId → { total units in stock now, number of fridges holding it } */
  stocks: Map<string, { qty: number; shops: number }>;
  shopsChecked: number;
  fillUps: FillUpRecord[];
  fillUpDays: number;
  fillUpsTotal: number;
  /** some fill-ups were not detailed (cap) */
  fillUpsCapped: boolean;
  environment: string;
}

export type Recommendation = "УДАЛИТЬ" | "ПРОВЕРИТЬ" | "ОСТАВИТЬ";

export interface ProductRow {
  recommendation: Recommendation;
  reason: string;
  product: ReportProduct;
  /** other KiT Shop products with the SAME name (different ProductId / barcode) — "ProductId (продано за 30 дн.)" */
  sameName: string;
  sold30: number;
  sold90: number;
  soldAll: number;
  /** end of the last 14-day window that had sales — "не продаётся с …" */
  lastSaleTo: number | null;
  lastSaleFrom: number | null;
  daysWithoutSales: number | null;
  stockNow: number;
  stockShops: number;
  loaded: number;
  removed: number;
  writeOffTagged: number;
  removedShare: number | null;
  lastLoaded: number | null;
}

const DAY = 86_400_000;
const fmt = (ms: number | null) => {
  if (ms === null) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
};
const isWriteOff = (notes: string | null) => !!notes && /спис/i.test(notes);

export function analyzeProducts(input: ReportInput): ProductRow[] {
  const now = input.generatedAt;
  const span = input.salesWindows.length ? now - input.salesWindows[input.salesWindows.length - 1].from : 0;
  const spanDays = Math.round(span / DAY);
  const loaded = new Map<string, number>();
  const removed = new Map<string, number>();
  const tagged = new Map<string, number>();
  const lastLoaded = new Map<string, number>();
  for (const f of input.fillUps)
    for (const l of f.lines) {
      if (l.qty > 0) {
        loaded.set(l.productId, (loaded.get(l.productId) ?? 0) + l.qty);
        if (f.at !== null && (lastLoaded.get(l.productId) ?? 0) < f.at) lastLoaded.set(l.productId, f.at);
      } else if (l.qty < 0) {
        removed.set(l.productId, (removed.get(l.productId) ?? 0) - l.qty);
        if (isWriteOff(f.notes)) tagged.set(l.productId, (tagged.get(l.productId) ?? 0) - l.qty);
      }
    }

  const rows = input.products
    .map((p): Omit<ProductRow, "sameName"> => {
      let sold30 = 0;
      let sold90 = 0;
      let soldAll = 0;
      let lastSale: SalesWindow | null = null;
      for (const w of input.salesWindows) {
        const q = w.qty.get(p.productId) ?? 0;
        soldAll += q;
        if (now - w.from <= 30 * DAY + DAY) sold30 += q;
        if (now - w.from <= 90 * DAY + DAY) sold90 += q;
        if (q > 0 && !lastSale) lastSale = w;
      }
      const st = input.stocks.get(p.productId) ?? { qty: 0, shops: 0 };
      const ld = loaded.get(p.productId) ?? 0;
      const rm = removed.get(p.productId) ?? 0;
      const tg = tagged.get(p.productId) ?? 0;
      const share = ld > 0 ? rm / ld : null;
      const lastSaleTo: number | null = lastSale ? (lastSale as SalesWindow).to : null;
      const lastSaleFrom: number | null = lastSale ? (lastSale as SalesWindow).from : null;
      const daysWithout = lastSaleTo !== null ? Math.max(0, Math.floor((now - lastSaleTo) / DAY)) : null;
      const row: Omit<ProductRow, "recommendation" | "reason" | "sameName"> = {
        product: p,
        sold30,
        sold90,
        soldAll,
        lastSaleTo,
        lastSaleFrom,
        daysWithoutSales: daysWithout,
        stockNow: Math.round(st.qty * 1000) / 1000,
        stockShops: st.shops,
        loaded: ld,
        removed: rm,
        writeOffTagged: tg,
        removedShare: share,
        lastLoaded: lastLoaded.get(p.productId) ?? null,
      };
      const d = input.fillUpDays;
      let recommendation: Recommendation = "ОСТАВИТЬ";
      let reason = "Продаётся";
      if (soldAll === 0 && st.qty <= 0 && ld === 0) {
        recommendation = "УДАЛИТЬ";
        reason = `Не продавался ${spanDays}+ дней, нет остатка ни в одном холодильнике, не загружался ${d} дней`;
      } else if (soldAll === 0 && st.qty > 0) {
        recommendation = "ПРОВЕРИТЬ";
        reason = `Лежит в ${st.shops} холодильн. (${row.stockNow} шт.), но не продавался ${spanDays}+ дней — снять/списать остаток, затем удалить`;
      } else if (soldAll === 0) {
        recommendation = "ПРОВЕРИТЬ";
        reason = `Загружали за ${d} дней (${ld} шт.), но продаж за ${spanDays}+ дней нет`;
      } else if (sold90 === 0 && st.qty <= 0 && ld === 0) {
        recommendation = "УДАЛИТЬ";
        reason = `Последняя продажа ~${daysWithout} дней назад, остатка нет, больше не загружается`;
      } else if (share !== null && share >= 0.4 && ld >= 5) {
        recommendation = "ПРОВЕРИТЬ";
        reason = `Много снятий: за ${d} дней снято ${Math.round(share * 100)}% загруженного (${rm} из ${ld} шт.${tg ? `, с пометкой «списание» ${tg}` : ""})`;
      } else if (sold30 === 0 && st.qty > 0) {
        recommendation = "ПРОВЕРИТЬ";
        reason = `Есть остаток (${row.stockNow} шт.), но за 30 дней ни одной продажи`;
      } else if (sold30 === 0 && ld === 0) {
        recommendation = "ПРОВЕРИТЬ";
        reason = `Не продаётся последние 30 дней и не загружается (последняя продажа ~${daysWithout} дней назад)`;
      }
      return { ...row, recommendation, reason };
    })
    ;

  // several KiT Shop cards with the same name (old duplicate vs the one that sells) — say it explicitly
  const key = (name: string) => name.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  const byName = new Map<string, typeof rows>();
  for (const r of rows) byName.set(key(r.product.name), [...(byName.get(key(r.product.name)) ?? []), r]);
  return rows
    .map((r): ProductRow => {
      const others = (byName.get(key(r.product.name)) ?? []).filter((o) => o !== r);
      const sameName = others.map((o) => `${o.product.productId} (продано за 30 дн.: ${o.sold30})`).join("; ");
      const sellingTwin = others.find((o) => o.sold30 > 0 || o.stockNow > 0);
      const reason =
        sellingTwin && r.recommendation !== "ОСТАВИТЬ"
          ? `ДУБЛЬ: такое же название есть у товара ${sellingTwin.product.productId} (штрихкод ${sellingTwin.product.barcode ?? "—"}), он продаётся — удалять только эту карточку ${r.product.productId}. ${r.reason}`
          : r.reason;
      return { ...r, reason, sameName };
    })
    .sort((a, b) => order(a.recommendation) - order(b.recommendation) || (b.daysWithoutSales ?? 9999) - (a.daysWithoutSales ?? 9999) || a.product.name.localeCompare(b.product.name, "ru"));
}

const order = (r: Recommendation) => (r === "УДАЛИТЬ" ? 0 : r === "ПРОВЕРИТЬ" ? 1 : 2);

const HEADER = [
  "Рекомендация",
  "Причина",
  "ProductId (KiT Shop)",
  "Название",
  "Штрихкод",
  "Артикул",
  "Цена",
  "Продано за 30 дн., шт.",
  "Продано за 90 дн., шт.",
  "Продано за весь период, шт.",
  "Последняя продажа (14-дневный период)",
  "Не продаётся примерно с",
  "Дней без продаж (≈)",
  "Остаток сейчас, шт.",
  "В скольких холодильниках остаток",
  "Загружено, шт.",
  "Снято, шт.",
  "Из них с пометкой «списание», шт.",
  "Доля снятий от загруженного, %",
  "Последняя загрузка",
  "Другие товары с таким же названием (ProductId)",
];
const WIDTHS = [14, 60, 14, 36, 16, 14, 9, 11, 11, 12, 24, 14, 11, 11, 12, 11, 10, 14, 12, 14, 30];

function rowCells(r: ProductRow, spanStart: number): CellValue[] {
  return [
    r.recommendation,
    r.reason,
    r.product.productId,
    r.product.name,
    r.product.barcode ?? "",
    r.product.vendorCode ?? "",
    r.product.price ?? "",
    r.sold30,
    r.sold90,
    r.soldAll,
    r.lastSaleFrom !== null ? `${fmt(r.lastSaleFrom)} – ${fmt(r.lastSaleTo)}` : `не продавался с ${fmt(spanStart)}`,
    r.lastSaleTo !== null ? fmt(r.lastSaleTo) : `ранее ${fmt(spanStart)}`,
    r.daysWithoutSales ?? "",
    r.stockNow,
    r.stockShops,
    r.loaded,
    r.removed,
    r.writeOffTagged,
    r.removedShare !== null ? Math.round(r.removedShare * 100) : "",
    fmt(r.lastLoaded),
    r.sameName,
  ];
}

export function buildUnusedProductsXlsx(input: ReportInput, rows = analyzeProducts(input)): Uint8Array {
  const spanStart = input.salesWindows.length ? input.salesWindows[input.salesWindows.length - 1].from : input.generatedAt;
  const action = rows.filter((r) => r.recommendation !== "ОСТАВИТЬ");
  const count = (rec: Recommendation) => rows.filter((r) => r.recommendation === rec).length;
  const how: CellValue[][] = [
    ["Отчёт «Неиспользуемые блюда» — Apps Холодосов"],
    [""],
    ["Сформирован", `${fmt(input.generatedAt)} (время Алматы)`],
    ["Источник данных", `KiT Shop REAL (только чтение) · ${input.environment}`],
    ["Период продаж", `${fmt(spanStart)} – ${fmt(input.generatedAt)} (${input.salesWindows.length} периодов по 14 дней, вся компания)`],
    ["Остатки", `на момент формирования, ${input.shopsChecked} торговых точек`],
    ["Загрузки / снятия", `последние ${input.fillUpDays} дней: ${input.fillUpsTotal} операций${input.fillUpsCapped ? " (детали получены не для всех — показаны самые свежие)" : ""}`],
    [""],
    ["Итого", `УДАЛИТЬ: ${count("УДАЛИТЬ")} · ПРОВЕРИТЬ: ${count("ПРОВЕРИТЬ")} · ОСТАВИТЬ: ${count("ОСТАВИТЬ")} · всего товаров: ${rows.length}`],
    [""],
    ["Правила"],
    ["УДАЛИТЬ", "Нет продаж за весь период, нет остатка, не загружался — или последняя продажа больше 90 дней назад, остатка нет и не загружается."],
    ["ПРОВЕРИТЬ", "Лежит остаток без продаж; много снятий (≥ 40% загруженного, от 5 шт.); нет продаж за 30 дней."],
    ["ОСТАВИТЬ", "Товар продаётся."],
    [""],
    ["Важно"],
    ["1", "Ничего не удаляется автоматически. Решение и удаление в кабинете KiT Shop — за менеджером."],
    ["2", "В API KiT Shop нет отдельного типа «списание»: «Снято» — все уменьшения остатка (перенос в другую точку, возврат, списание). Колонка «с пометкой списание» — операции, в примечании которых есть слово «списание»."],
    ["3", "Дата последней продажи известна с точностью до 14-дневного периода (так KiT Shop отдаёт продажи по товарам)."],
    ["4", "Новые товары (заведены недавно) могут попасть в «ПРОВЕРИТЬ» — смотрите на дату последней загрузки."],
    ["5", "В KiT Shop бывает несколько карточек с одинаковым названием (разные ProductId и штрихкоды). Отчёт считает каждую карточку отдельно; строки с пометкой «ДУБЛЬ» — старая карточка, удалять только её, а не продающуюся. Сверяйте по ProductId и штрихкоду."],
  ];
  return buildXlsx([
    { name: "Для менеджеров", rows: [HEADER, ...action.map((r) => rowCells(r, spanStart))], widths: WIDTHS },
    { name: "Все товары", rows: [HEADER, ...rows.map((r) => rowCells(r, spanStart))], widths: WIDTHS },
    { name: "Как считали", rows: how, widths: [22, 120], header: false },
  ]);
}
