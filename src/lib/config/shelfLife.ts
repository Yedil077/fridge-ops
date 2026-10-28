/**
 * Shelf life (срок годности) in hours: per category, overridable per dish in Настройки / the dish card (ADMIN).
 * Main dishes / hot 48 h, desserts 72 h, drinks 72 h; the other categories 48 h until set otherwise.
 */

export const DEFAULT_SHELF_HOURS: Record<string, number> = {
  breakfast: 48,
  hot: 48,
  salad: 48,
  snack: 48,
  dessert: 72,
  drink: 72,
};

export interface ShelfLifeSettings {
  /** category id → hours */
  categories: Record<string, number>;
  /** our product id (e.g. "K123456") → hours */
  products: Record<string, number>;
}

export const emptyShelfLife = (): ShelfLifeSettings => ({ categories: {}, products: {} });

export function shelfHoursFor(s: ShelfLifeSettings | undefined, productId: string, categoryId: string): { hours: number; source: "product" | "category" } {
  const own = s?.products[productId];
  if (own) return { hours: own, source: "product" };
  return { hours: s?.categories[categoryId] ?? DEFAULT_SHELF_HOURS[categoryId] ?? 48, source: "category" };
}

/** 6 h … 14 days, whole hours */
export const validShelfHours = (h: unknown): h is number => typeof h === "number" && Number.isInteger(h) && h >= 6 && h <= 336;
