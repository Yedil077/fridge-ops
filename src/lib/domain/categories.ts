import type { Category, CategoryId } from "./types";

export const CATEGORIES: Category[] = [
  { id: "breakfast", name: "Завтраки", short: "Завтр.", emoji: "🥐", shelfLifeDays: 1, wasteShare: [1, 1], core: true },
  { id: "hot", name: "Горячее", short: "Гор.", emoji: "🔥", shelfLifeDays: 2, wasteShare: [0.5, 1], core: true },
  { id: "salad", name: "Салаты", short: "Сал.", emoji: "🥗", shelfLifeDays: 1, wasteShare: [1, 1], core: true },
  { id: "snack", name: "Перекусы", short: "Перек.", emoji: "🥪", shelfLifeDays: 3, wasteShare: [0.2, 0.8], core: true },
  { id: "dessert", name: "Десерты", short: "Дес.", emoji: "🍰", shelfLifeDays: 2, wasteShare: [0.5, 1], core: true },
  { id: "drink", name: "Напитки", short: "Нап.", emoji: "🥤", shelfLifeDays: 60, wasteShare: [0, 0], core: false },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

export function categoryIndex(id: CategoryId): number {
  return CATEGORY_IDS.indexOf(id);
}

export function categoryById(id: CategoryId): Category {
  const c = CATEGORIES.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown category ${id}`);
  return c;
}

/**
 * Chart colors per category (dark surface steps of the validated categorical palette,
 * fixed order — color follows the category, never its rank).
 */
export const CATEGORY_COLORS: Record<CategoryId, string> = {
  breakfast: "#3987e5",
  hot: "#d95926",
  salad: "#199e70",
  snack: "#c98500",
  dessert: "#d55181",
  drink: "#9085e9",
};
