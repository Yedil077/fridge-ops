import { buildXlsx, type CellValue } from "./xlsx";

/**
 * "Что можно удалить из KiT Shop" — CONSERVATIVE report for managers, built only from a FRESH read of the real KiT Shop.
 *
 * Main rule: a false "delete" is worse than keeping 20 old cards. Missing sales alone never means "unused".
 *  • every signal counts: sales, loads, removals (60 days), current stock, age of the card;
 *  • a card younger than 60 days (or whose age cannot be proven) is never "УДАЛИТЬ";
 *  • managers work with FULL NAMES: if any card of a name is active / new, the whole name stays;
 *  • "УДАЛИТЬ" only with HIGH confidence and only when every data source loaded completely.
 *
 * Age of a card: KiT Shop does not return a creation date. ProductIds grow with creation, so a card whose id is
 * below the id of any product already active 60+ days ago was created 60+ days ago (proven age). Cards above that
 * threshold may be new → НОВЫЙ.
 */

export type Status = "УДАЛИТЬ" | "МОЖНО ПРОВЕРИТЬ" | "ОСТАВИТЬ" | "НОВЫЙ" | "НЕ ХВАТАЕТ ДАННЫХ";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";

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
  qty: Map<string, number>;
}

export interface FillUpRecord {
  at: number | null;
  type: number | null;
  notes: string | null;
  shopId: string;
  lines: { productId: string; qty: number }[];
}

export interface DataCompleteness {
  products: boolean;
  /** every sales window loaded */
  sales: boolean;
  /** stock of every shop loaded */
  stocks: boolean;
  /** fill-up list loaded AND every fill-up detailed */
  fillUps: boolean;
}

export interface EndpointLog {
  endpoint: string;
  ok: number;
  failed: number;
  note: string;
}

export interface ReportInput {
  generatedAt: number;
  /** when the KiT Shop read finished */
  dataReadAt: number;
  products: ReportProduct[];
  /** newest first, contiguous, 14 days each */
  salesWindows: SalesWindow[];
  stocks: Map<string, { qty: number; shops: number }>;
  shopsChecked: number;
  fillUps: FillUpRecord[];
  fillUpDays: number;
  fillUpsTotal: number;
  complete: DataCompleteness;
  endpoints: EndpointLog[];
  environment: string;
}

export interface CardRow {
  product: ReportProduct;
  status: Status;
  confidence: Confidence;
  why: string;
  firstSeen: number | null;
  lastSale: number | null;
  lastLoad: number | null;
  lastRemoval: number | null;
  lastActivity: number | null;
  daysInactive: number | null;
  stockNow: number;
  stockShops: number;
  sold60: number;
  soldAll: number;
  loaded60: number;
  removed60: number;
  /** id is below the id of a product already active 60+ days ago */
  ageProven: boolean;
}

export interface NameRow {
  name: string;
  status: Status;
  confidence: Confidence;
  why: string;
  cards: CardRow[];
  firstSeen: number | null;
  lastSale: number | null;
  lastLoad: number | null;
  lastRemoval: number | null;
  lastActivity: number | null;
  daysInactive: number | null;
  stockNow: number;
  sold60: number;
  loaded60: number;
}

const DAY = 86_400_000;
export const MIN_AGE_DAYS = 60;
/** sales are known per 14-day window: "no sales in 60 days" is checked over 5 windows (70 days) — stricter, never looser */
const SALES_WINDOWS_FOR_60D = 5;

const fmt = (ms: number | null) => {
  if (ms === null) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
};
const max = (...v: (number | null)[]) => v.reduce<number | null>((a, b) => (b === null ? a : a === null ? b : Math.max(a, b)), null);
const min = (...v: (number | null)[]) => v.reduce<number | null>((a, b) => (b === null ? a : a === null ? b : Math.min(a, b)), null);

/** Only safe normalisation: case and whitespace. Volume, garnish, meat, taste, size stay. */
export const normalizeName = (name: string) => name.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();

const idNum = (id: string) => (/^\d+$/.test(id) ? Number(id) : NaN);

export function analyzeCards(input: ReportInput): CardRow[] {
  const now = input.generatedAt;
  const cutoff = now - MIN_AGE_DAYS * DAY;
  const loads = new Map<string, { qty: number; first: number | null; last: number | null }>();
  const removals = new Map<string, { qty: number; last: number | null }>();
  for (const f of input.fillUps)
    for (const l of f.lines) {
      if (l.qty > 0) {
        const cur = loads.get(l.productId) ?? { qty: 0, first: null, last: null };
        loads.set(l.productId, { qty: cur.qty + l.qty, first: min(cur.first, f.at), last: max(cur.last, f.at) });
      } else if (l.qty < 0) {
        const cur = removals.get(l.productId) ?? { qty: 0, last: null };
        removals.set(l.productId, { qty: cur.qty - l.qty, last: max(cur.last, f.at) });
      }
    }

  // sales per product: first / last window with sales
  const sales = new Map<string, { first: number | null; last: number | null; sold60: number; all: number }>();
  input.salesWindows.forEach((w, i) => {
    for (const [id, q] of w.qty) {
      if (q <= 0) continue;
      const cur = sales.get(id) ?? { first: null, last: null, sold60: 0, all: 0 };
      sales.set(id, {
        first: min(cur.first, w.from),
        last: max(cur.last, w.to),
        sold60: cur.sold60 + (i < SALES_WINDOWS_FOR_60D ? q : 0),
        all: cur.all + q,
      });
    }
  });

  // age threshold: highest ProductId among products already active before the cutoff (proven ≥ 60 days old)
  let ageThreshold = -Infinity;
  for (const [id, s] of sales) if (s.first !== null && s.first <= cutoff && idNum(id) > ageThreshold) ageThreshold = idNum(id);

  const fullData = input.complete.products && input.complete.sales && input.complete.stocks;

  return input.products.map((p): CardRow => {
    const s = sales.get(p.productId) ?? { first: null, last: null, sold60: 0, all: 0 };
    const ld = loads.get(p.productId) ?? { qty: 0, first: null, last: null };
    const rm = removals.get(p.productId) ?? { qty: 0, last: null };
    const st = input.stocks.get(p.productId) ?? { qty: 0, shops: 0 };
    const stockNow = Math.round(st.qty * 1000) / 1000;
    const firstSeen = min(s.first, ld.first, stockNow > 0 ? now : null);
    const lastActivity = max(s.last, ld.last, rm.last, stockNow > 0 ? now : null);
    const daysInactive = lastActivity !== null ? Math.max(0, Math.floor((now - lastActivity) / DAY)) : null;
    const ageProven = (s.first !== null && s.first <= cutoff) || idNum(p.productId) <= ageThreshold;
    const base = {
      product: p,
      firstSeen,
      lastSale: s.last,
      lastLoad: ld.last,
      lastRemoval: rm.last,
      lastActivity,
      daysInactive,
      stockNow,
      stockShops: st.shops,
      sold60: s.sold60,
      soldAll: s.all,
      loaded60: ld.qty,
      removed60: rm.qty,
      ageProven,
    };
    const signals: string[] = [];
    if (s.sold60 > 0) signals.push(`продажи за 60 дней: ${s.sold60} шт. (последняя до ${fmt(s.last)})`);
    if (ld.qty > 0) signals.push(`загрузки за ${input.fillUpDays} дней: ${ld.qty} шт. (последняя ${fmt(ld.last)})`);
    if (rm.qty > 0) signals.push(`снятия за ${input.fillUpDays} дней: ${rm.qty} шт. (последнее ${fmt(rm.last)})`);
    if (stockNow > 0) signals.push(`остаток сейчас ${stockNow} шт. в ${st.shops} холодильн.`);

    // 1. new: first seen less than 60 days ago — never deleted, even with 0 sales
    if (firstSeen !== null && firstSeen > cutoff && !ageProven)
      return { ...base, status: "НОВЫЙ", confidence: "HIGH", why: `Первое появление ${fmt(firstSeen)}, прошло ${Math.floor((now - firstSeen) / DAY)} дн. Недостаточно истории — не удалять.` };
    // 2. any sign of use → keep
    if (signals.length) return { ...base, status: "ОСТАВИТЬ", confidence: "HIGH", why: `Используется: ${signals.join("; ")}.` };
    // 3. no activity, but the card may have been created recently (id above every product active 60+ days ago)
    if (!ageProven)
      return {
        ...base,
        status: "НОВЫЙ",
        confidence: "MEDIUM",
        why: "Активности ещё не было, но карточка, судя по ProductId, создана недавно (позже товаров, активных 60+ дней назад). Не удалять, пока не пройдёт 60 дней.",
      };
    // 4. no activity and old — but only a COMPLETE read may say "delete"
    const lastText = lastActivity !== null ? `Последняя активность ${fmt(lastActivity)} (${daysInactive} дн. назад)` : "Активности за весь период наблюдения нет";
    if (!fullData)
      return { ...base, status: "НЕ ХВАТАЕТ ДАННЫХ", confidence: "LOW", why: `${lastText}, но часть данных KiT Shop (продажи / остатки / каталог) не загрузилась — решение отложено.` };
    if (!input.complete.fillUps)
      return { ...base, status: "МОЖНО ПРОВЕРИТЬ", confidence: "MEDIUM", why: `${lastText}; продаж 0, остаток 0, но загрузки/снятия загрузились не полностью — проверить вручную.` };
    if (lastActivity !== null && lastActivity > cutoff)
      return { ...base, status: "МОЖНО ПРОВЕРИТЬ", confidence: "MEDIUM", why: `${lastText} — меньше 60 дней.` };
    return {
      ...base,
      status: "УДАЛИТЬ",
      confidence: "HIGH",
      why: `${lastText}; за последние 60 дней продаж 0, загрузок 0, снятий 0, остаток 0; карточке больше 60 дней.`,
    };
  });
}

const RANK: Record<Status, number> = { ОСТАВИТЬ: 0, НОВЫЙ: 1, "НЕ ХВАТАЕТ ДАННЫХ": 2, "МОЖНО ПРОВЕРИТЬ": 3, УДАЛИТЬ: 4 };

/** One row per FULL NAME. The safest card decides: one active / new card keeps the whole name. */
export function analyzeNames(input: ReportInput, cards = analyzeCards(input)): NameRow[] {
  const groups = new Map<string, CardRow[]>();
  for (const c of cards) {
    const k = normalizeName(c.product.name);
    if (k) groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const rows: NameRow[] = [];
  for (const group of groups.values()) {
    const decisive = group.reduce((a, b) => (RANK[b.status] < RANK[a.status] ? b : a));
    const status = decisive.status;
    let why = decisive.why;
    if (group.length > 1) {
      why =
        status === "УДАЛИТЬ"
          ? `Все ${group.length} карточки с этим названием неактивны. ${decisive.why}`
          : `Карточек с этим названием: ${group.length}; решает самая «живая» (ID ${decisive.product.productId}): ${decisive.why}`;
    }
    const lastActivity = max(...group.map((c) => c.lastActivity));
    rows.push({
      name: group[0].product.name.replace(/\s+/g, " ").trim(),
      status,
      confidence: status === "УДАЛИТЬ" && group.every((c) => c.confidence === "HIGH") ? "HIGH" : decisive.confidence,
      why,
      cards: group,
      firstSeen: min(...group.map((c) => c.firstSeen)),
      lastSale: max(...group.map((c) => c.lastSale)),
      lastLoad: max(...group.map((c) => c.lastLoad)),
      lastRemoval: max(...group.map((c) => c.lastRemoval)),
      lastActivity,
      daysInactive: lastActivity !== null ? Math.max(0, Math.floor((input.generatedAt - lastActivity) / DAY)) : null,
      stockNow: group.reduce((a, c) => a + c.stockNow, 0),
      sold60: group.reduce((a, c) => a + c.sold60, 0),
      loaded60: group.reduce((a, c) => a + c.loaded60, 0),
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

/** Rows allowed in «ТОЧНО УДАЛИТЬ». Any violation is a bug → the file must not be produced. */
export function sanityCheck(rows: NameRow[]): string[] {
  const errors: string[] = [];
  for (const r of rows.filter((x) => x.status === "УДАЛИТЬ")) {
    if (r.confidence !== "HIGH") errors.push(`${r.name}: УДАЛИТЬ без HIGH`);
    if (r.sold60 > 0) errors.push(`${r.name}: есть продажи за 60 дней`);
    if (r.loaded60 > 0) errors.push(`${r.name}: есть загрузки за 60 дней`);
    if (r.stockNow > 0) errors.push(`${r.name}: есть остаток`);
    if (r.cards.some((c) => c.status !== "УДАЛИТЬ")) errors.push(`${r.name}: есть активная / новая карточка с тем же названием`);
    if (r.cards.some((c) => !c.ageProven)) errors.push(`${r.name}: возраст карточки не доказан (возможно, новая)`);
  }
  return errors;
}

const HEADER = [
  "Название",
  "Статус",
  "Уверенность",
  "Почему",
  "Первое появление",
  "Последняя продажа (до)",
  "Последняя загрузка",
  "Последнее снятие",
  "Последняя активность",
  "Дней без активности",
  "Текущий остаток, шт.",
  "Продано за 60 дн., шт.",
  "Загружено за 60 дн., шт.",
  "Карточек с этим названием",
  "ProductId (для справки)",
];
const WIDTHS = [42, 18, 12, 70, 14, 14, 14, 14, 14, 12, 12, 12, 12, 12, 24];

const cells = (r: NameRow): CellValue[] => [
  r.name,
  r.status,
  r.confidence,
  r.why,
  fmt(r.firstSeen) || "нет данных",
  fmt(r.lastSale),
  fmt(r.lastLoad),
  fmt(r.lastRemoval),
  fmt(r.lastActivity) || "нет",
  r.daysInactive ?? "",
  r.stockNow,
  r.sold60,
  r.loaded60,
  r.cards.length,
  r.cards.map((c) => c.product.productId).join(", "),
];

export function buildUnusedProductsXlsx(input: ReportInput, rows = analyzeNames(input)): Uint8Array {
  const errors = sanityCheck(rows);
  if (errors.length) throw new Error(`Проверка перед выдачей не пройдена, файл не создан: ${errors.slice(0, 5).join("; ")}`);
  const by = (s: Status[]) => rows.filter((r) => s.includes(r.status));
  const count = (s: Status) => rows.filter((r) => r.status === s).length;
  const span = input.salesWindows.length ? input.salesWindows[input.salesWindows.length - 1].from : input.generatedAt;
  const how: CellValue[][] = [
    ["Отчёт «Что можно удалить из KiT Shop» — Apps Холодосов"],
    [""],
    ["Данные получены из KiT Shop", `${fmt(input.dataReadAt)} ${new Date(input.dataReadAt).toISOString().slice(11, 16)} (свежее чтение, только чтение)`],
    ["Среда", input.environment],
    ["Итого (по названиям)", `ТОЧНО УДАЛИТЬ: ${count("УДАЛИТЬ")} · ПРОВЕРИТЬ: ${count("МОЖНО ПРОВЕРИТЬ") + count("НЕ ХВАТАЕТ ДАННЫХ")} · НОВЫЕ: ${count("НОВЫЙ")} · ОСТАВИТЬ: ${count("ОСТАВИТЬ")} · всего названий: ${rows.length}`],
    [""],
    ["Источники данных"],
    ...input.endpoints.map((e): CellValue[] => [e.endpoint, `успешно: ${e.ok}, ошибок: ${e.failed}${e.note ? ` · ${e.note}` : ""}`]),
    ["Полнота", `каталог: ${input.complete.products ? "да" : "НЕТ"} · продажи: ${input.complete.sales ? "да" : "НЕТ"} · остатки: ${input.complete.stocks ? "да" : "НЕТ"} · загрузки/снятия: ${input.complete.fillUps ? "да" : "НЕТ"}`],
    ["Продажи", `${fmt(span)} – ${fmt(input.generatedAt)}, периоды по 14 дней, вся компания`],
    ["Загрузки / снятия", `последние ${input.fillUpDays} дней, операций: ${input.fillUpsTotal}`],
    ["Остатки", `${input.shopsChecked} торговых точек, на момент чтения`],
    [""],
    ["Правила"],
    ["ТОЧНО УДАЛИТЬ", "Только HIGH: все карточки с этим названием старше 60 дней; за последние 60 дней ни продаж, ни загрузок, ни снятий; остаток 0; последняя активность больше 60 дней назад; все данные KiT Shop загрузились полностью."],
    ["НОВЫЙ", "Первое появление меньше 60 дней назад, или карточка создана недавно (ProductId новее, чем у товаров, которые продавались 60+ дней назад). Не удалять, даже если продаж 0."],
    ["ОСТАВИТЬ", "Есть хоть один признак использования: продажа за 60 дней, загрузка или снятие за 60 дней, остаток сейчас."],
    ["МОЖНО ПРОВЕРИТЬ", "Активности нет, но уверенности недостаточно (например, активность была меньше 60 дней назад или загрузки прочитаны не полностью)."],
    ["НЕ ХВАТАЕТ ДАННЫХ", "Часть данных KiT Shop не загрузилась — решение не принимается."],
    [""],
    ["Как сравниваются названия", "Только полное название: регистр и пробелы не важны, но объём, гарнир, мясо, вкус и размер различаются («Каркаде 330 мл» и «Каркаде 500 мл» — разные блюда). Если хоть одна карточка названия активна или новая — всё название остаётся."],
    ["Важно", "Дата создания карточки в API KiT Shop отсутствует: «первое появление» — самая ранняя наблюдаемая активность. Продажи известны с точностью до 14 дней, поэтому «60 дней без продаж» проверяется по 70 дням — строже. Ничего не удаляется автоматически."],
  ];
  return buildXlsx([
    { name: "ТОЧНО УДАЛИТЬ", rows: [HEADER, ...by(["УДАЛИТЬ"]).map(cells)], widths: WIDTHS },
    { name: "ПРОВЕРИТЬ", rows: [HEADER, ...by(["МОЖНО ПРОВЕРИТЬ", "НЕ ХВАТАЕТ ДАННЫХ"]).map(cells)], widths: WIDTHS },
    { name: "ОСТАВИТЬ", rows: [HEADER, ...by(["ОСТАВИТЬ"]).map(cells)], widths: WIDTHS },
    { name: "НОВЫЕ", rows: [HEADER, ...by(["НОВЫЙ"]).map(cells)], widths: WIDTHS },
    { name: "ВСЕ ТОВАРЫ", rows: [HEADER, ...rows.map(cells)], widths: WIDTHS },
    { name: "КАК СЧИТАЛИ", rows: how, widths: [26, 130], header: false },
  ]);
}
