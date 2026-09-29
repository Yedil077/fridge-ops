import { ENGINE_CONFIG } from "../config/engine";
import type { Category, CategoryForecast, FridgeStatus, RiskState } from "../domain/types";

/** Safety stock: never plan to leave a fridge with less than this. */
export function safetyStock(expected1h: number): number {
  const { minSafetyUnits, safetyHours } = ENGINE_CONFIG.risk;
  return Math.max(minSafetyUnits, Math.ceil(expected1h * safetyHours));
}

/**
 * Units expected to be written off: leftovers at close × waste share,
 * where the share depends on shelf life and whether the fridge works tomorrow.
 */
export function wasteUnits(category: Category, stock: number, expectedUntilClose: number, workingTomorrow: boolean): number {
  const leftover = Math.max(0, stock - expectedUntilClose);
  return leftover * category.wasteShare[workingTomorrow ? 0 : 1];
}

export function classify(
  cf: Pick<CategoryForecast, "stock" | "expected2h" | "expectedUntilClose" | "projected2h" | "safetyStock" | "wasteUnits">,
): RiskState {
  const { overstockRatio, overstockMinUnits, wasteMinUnits } = ENGINE_CONFIG.risk;
  if (cf.projected2h <= 0 && cf.expected2h >= 1) return "EMPTY_RISK";
  if (cf.projected2h < cf.safetyStock && cf.expected2h >= 0.5) return "LOW_STOCK";
  if (cf.wasteUnits >= wasteMinUnits) return "WASTE_RISK";
  const surplus = cf.stock - cf.expectedUntilClose;
  if (cf.stock > cf.expectedUntilClose * overstockRatio && surplus >= overstockMinUnits) return "OVERSTOCK";
  return "NORMAL";
}

const PENALTY: Record<RiskState, number> = {
  EMPTY_RISK: 1,
  LOW_STOCK: 0.5,
  WASTE_RISK: 0.35,
  OVERSTOCK: 0.2,
  NORMAL: 0,
  CLOSED: 0,
};

export function fridgeHealth(cats: CategoryForecast[], weights: number[]): number {
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  let pen = 0;
  cats.forEach((c, i) => (pen += (weights[i] / wsum) * PENALTY[c.state]));
  return Math.max(0, Math.min(1, 1 - pen));
}

export function fridgeStatus(isOpen: boolean, cats: CategoryForecast[], categories: Category[], anomaly: boolean): FridgeStatus {
  if (!isOpen) return "closed";
  if (cats.some((c, i) => categories[i].core && c.state === "EMPTY_RISK")) return "critical";
  if (anomaly || cats.some((c, i) => categories[i].core && (c.state === "LOW_STOCK" || c.state === "WASTE_RISK"))) return "attention";
  return "normal";
}
