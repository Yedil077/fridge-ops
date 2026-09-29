import type { CategoryId, HistoryCube, Product } from "@/lib/domain/types";
import { CATEGORIES } from "@/lib/domain/categories";
import type { KitShopProduct, KitShopSale } from "./types";

/**
 * Maps KitShop DTOs to our domain. Pure functions — no network, no writes.
 */

/** Keyword rules to map a KitShop product group/name to our category. Editable once real groups are known. */
export const CATEGORY_RULES: { category: CategoryId; keywords: string[] }[] = [
  { category: "breakfast", keywords: ["завтрак", "сырник", "омлет", "каша", "блин", "круассан"] },
  { category: "hot", keywords: ["горяч", "паста", "плов", "гречк", "лазань", "курица", "котлет", "суп"] },
  { category: "salad", keywords: ["салат", "боул", "винегрет", "цезарь"] },
  { category: "dessert", keywords: ["десерт", "торт", "чизкейк", "тирамису", "медовик", "панна"] },
  { category: "drink", keywords: ["напит", "вода", "сок", "морс", "чай", "кофе", "смузи", "кефир"] },
  { category: "snack", keywords: ["перекус", "сэндвич", "ролл", "пирож", "хумус", "снек"] },
];

export function categorize(p: Pick<KitShopProduct, "name" | "group">): CategoryId {
  const text = `${p.group ?? ""} ${p.name}`.toLowerCase();
  for (const rule of CATEGORY_RULES) if (rule.keywords.some((k) => text.includes(k))) return rule.category;
  return "snack";
}

export function toProduct(p: KitShopProduct): Product {
  return {
    id: `K${p.productId}`,
    externalId: String(p.productId),
    name: p.name,
    categoryId: categorize(p),
    price: p.price ?? 0,
    // short code / photo / barcode — mapped once the real product fields are known
    sku: typeof p.sku === "string" ? p.sku : String(p.productId).slice(-5),
    imageUrl: typeof p.imageUrl === "string" ? p.imageUrl : null,
    barcode: typeof p.barcode === "string" ? p.barcode : null,
  };
}

/**
 * Converts a KitShop timestamp to our wall-clock ms in the fridges' timezone.
 * If the string has no offset it is assumed to already be local wall-clock time.
 */
export function toWallClock(iso: string, timeZone: string): number {
  const hasOffset = /[zZ]|[+-]\d\d:?\d\d$/.test(iso);
  if (!hasOffset) return Date.parse(`${iso}Z`);
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const g = (t: string) => Number(parts.find((x) => x.type === t)?.value ?? 0);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
}

/**
 * Aggregates raw sales into the history cube used by the engine.
 * Returns (quantity may be negative) are included as negative sales.
 */
export function aggregateSales(
  sales: KitShopSale[],
  shopIndex: Map<string, number>,
  productIndex: Map<string, number>,
  products: Product[],
  startDay: number,
  days: number,
  timeZone: string,
): HistoryCube {
  const F = shopIndex.size;
  const C = CATEGORIES.length;
  const P = products.length;
  const hourly = new Float32Array(F * C * days * 24);
  const productDaily = new Float32Array(F * P * days);
  const catIdx = new Map(CATEGORIES.map((c, i) => [c.id, i]));
  for (const s of sales) {
    const f = shopIndex.get(String(s.shopId));
    const p = productIndex.get(String(s.productId));
    if (f === undefined || p === undefined) continue;
    const t = toWallClock(s.soldAt, timeZone);
    const d = Math.floor(t / 86_400_000) - startDay;
    if (d < 0 || d >= days) continue;
    const h = new Date(t).getUTCHours();
    const c = catIdx.get(products[p].categoryId)!;
    hourly[((f * C + c) * days + d) * 24 + h] += s.quantity;
    productDaily[(f * P + p) * days + d] += s.quantity;
  }
  return { startDay, days, hourly, productDaily, holidays: [] };
}
