import type { CategoryId, HistoryCube, Product } from "@/lib/domain/types";
import { CATEGORIES } from "@/lib/domain/categories";
import type { KitShopProduct } from "./types";

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

export function categorize(name: string, group?: string | null): CategoryId {
  const text = `${group ?? ""} ${name}`.toLowerCase();
  for (const rule of CATEGORY_RULES) if (rule.keywords.some((k) => text.includes(k))) return rule.category;
  return "snack";
}

export function toProduct(p: KitShopProduct, groupName?: string | null): Product {
  return {
    id: `K${p.ProductId}`,
    externalId: p.ProductId,
    name: p.ProductName,
    categoryId: categorize(p.ProductName, groupName),
    price: p.Price ?? 0,
    sku: p.VendorCode || p.ShortCodes || p.ProductId.slice(-5),
    imageUrl: null,
    barcode: p.Barcode || null,
  };
}

/** One sold product line (from sale details), already in our wall-clock time. */
export interface SaleLine {
  shopId: string;
  productId: string;
  quantity: number;
  /** wall-clock ms */
  soldAt: number;
}

/**
 * Aggregates sale lines into the history cube used by the engine.
 * Returns (quantity may be negative) are included as negative sales.
 */
export function aggregateSales(
  sales: SaleLine[],
  shopIndex: Map<string, number>,
  productIndex: Map<string, number>,
  products: Product[],
  startDay: number,
  days: number,
): HistoryCube {
  const F = shopIndex.size;
  const C = CATEGORIES.length;
  const P = products.length;
  const hourly = new Float32Array(F * C * days * 24);
  const productDaily = new Float32Array(F * P * days);
  const catIdx = new Map(CATEGORIES.map((c, i) => [c.id, i]));
  for (const s of sales) {
    const f = shopIndex.get(s.shopId);
    const p = productIndex.get(s.productId);
    if (f === undefined || p === undefined) continue;
    const d = Math.floor(s.soldAt / 86_400_000) - startDay;
    if (d < 0 || d >= days) continue;
    const h = new Date(s.soldAt).getUTCHours();
    const c = catIdx.get(products[p].categoryId)!;
    hourly[((f * C + c) * days + d) * 24 + h] += s.quantity;
    productDaily[(f * P + p) * days + d] += s.quantity;
  }
  return { startDay, days, hourly, productDaily, holidays: [] };
}
