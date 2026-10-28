import { ENGINE_CONFIG } from "../config/engine";
import type { ForecastMode, FridgeForecast } from "../domain/types";
import { sumWindow } from "./forecast";
import type { EngineContext } from "./history";
import { productStats, type ProductStat } from "./productNorm";

/**
 * DEMAND — the ONE source of truth for "how much is needed / how much can be given".
 * Built on the PRODUCT analytics (engine/productNorm.ts): every dish in every fridge has its norm per day; the transfer
 * recommendations and the analytics screen read these numbers; nothing else computes them.
 *
 * For one fridge × dish (all in whole units):
 *   share of today left = the fridge's usual sales from now until the end of the horizon ÷ its usual day
 *   target   = norm × share  →  0 below 0.3, otherwise max(1, ⌈x − 0.2⌉)     ("сегодня рекомендуется иметь")
 *   need     = target − stock − already promised in   (only while the fridge sells now)
 *   keep     = what it should have for the rest of today, at least 1 if it has the dish;
 *              a dish WITHOUT a norm (not enough data) is never taken away and never asked for
 *   surplus  = stock − promised out − keep            (≤ 0 → it cannot be a source of this dish)
 * A category is just the sum of its dishes: a need for salads is "Цезарь +2, Сельдь +1", never "any 3 salads".
 *
 * Horizons: NOW = the rest of today; UNTIL_EVENING = until the time in Настройки (after it: the rest of today).
 */

export type Horizon = "NOW" | "UNTIL_EVENING";

export const horizonOfMode = (mode: ForecastMode): Horizon => (mode === "until20" ? "UNTIL_EVENING" : "NOW");
export const modeOfHorizon = (h: Horizon): ForecastMode => (h === "UNTIL_EVENING" ? "until20" : "realtime");

/** Units already promised by open (accepted / in progress) transfers. */
export interface Promised {
  sourceIndex: number;
  targetIndex: number;
  categoryIndex: number;
  qty: number;
  products?: { productIndex: number; qty: number }[];
}

export interface ProductCell {
  f: number;
  p: number;
  stock: number;
  /** expected sales of the dish in the horizon (rate × share) */
  expected: number;
  /** what the fridge should have now for the horizon */
  target: number;
  need: number;
  keep: number;
  surplus: number;
  inbound: number;
  outbound: number;
  reason: string;
}

export interface DemandCell {
  stock: number;
  expected: number;
  safety: number;
  projected: number;
  need: number;
  surplus: number;
  keep: number;
  confidence: number;
  /** runs empty within criticalMinutes */
  critical: boolean;
  /** can receive now (active, enough activity left) */
  targetEligible: boolean;
  /** can give now */
  sourceEligible: boolean;
  inbound: number;
  outbound: number;
  /** one plain sentence: why this need / surplus (lists the dishes) */
  reason: string;
}

export interface DemandGrid {
  /** fridge × category = sum of its dishes */
  cells: DemandCell[][];
  /** F*P, undefined = the dish has nothing to do with this fridge */
  products: (ProductCell | undefined)[];
}

/** End of the horizon (minutes from today's 00:00, never past midnight). */
export function horizonEnd(h: Horizon, nowMinute: number, untilMinute: number): number {
  if (h === "UNTIL_EVENING" && untilMinute > nowMinute) return untilMinute;
  return 1440;
}

/** Share of a usual day of this fridge that is still ahead in [now, end). Weak days (e.g. Saturday) give a small share. */
export function shareLeft(ff: FridgeForecast, nowMinute: number, end: number): number {
  const curve = new Array<number>(24).fill(0);
  for (const cf of ff.categories) cf.normalHourly.forEach((v, h) => (curve[h] += v));
  const day = curve.reduce((a, b) => a + b, 0);
  const denom = Math.max(day, ff.typicalDayTotal);
  if (denom <= 0) return 0;
  return Math.min(1, sumWindow(curve, nowMinute, end) / denom);
}

/** Units to have for an expected x: nothing for a fraction of a sale, at least 1 otherwise. */
export const targetUnits = (x: number) => (x < 0.3 ? 0 : Math.max(1, Math.ceil(x - 0.2)));

const r1 = (x: number) => Math.round(x * 10) / 10;

function fmt(m: number): string {
  if (m >= 1440) return "конца дня";
  const x = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
}

export function demandGrid(
  ctx: EngineContext,
  forecasts: FridgeForecast[],
  opts: { horizon: Horizon; untilMinute: number; promised?: Promised[] },
): DemandGrid {
  const T = ENGINE_CONFIG.transfer;
  const stats = productStats(ctx);
  const { F, P } = ctx;
  const inbound = new Float64Array(F * P);
  const outbound = new Float64Array(F * P);
  for (const r of opts.promised ?? [])
    for (const x of r.products ?? []) {
      inbound[r.targetIndex * P + x.productIndex] += x.qty;
      outbound[r.sourceIndex * P + x.productIndex] += x.qty;
    }
  const end = horizonEnd(opts.horizon, ctx.nowMinute, opts.untilMinute);
  const catIdx = new Map(ctx.snap.categories.map((c, i) => [c.id, i]));
  const products: (ProductCell | undefined)[] = new Array(F * P);

  const cells: DemandCell[][] = forecasts.map((ff, f) => {
    const targetEligible = ff.isOpenNow && ff.minutesToClose >= T.minTargetOpenMinutes;
    const sourceEligible = ff.isOpenNow || (T.allowClosedSource && ff.isWorkingToday);
    const share = shareLeft(ff, ctx.nowMinute, end);
    const shareDay = shareLeft(ff, ctx.nowMinute, 1440);
    const perCat = ctx.snap.categories.map(() => [] as ProductCell[]);
    for (let p = 0; p < P; p++) {
      const st: ProductStat | undefined = stats.at[f * P + p];
      if (!st) continue;
      const stock = ctx.snap.stock[f * P + p];
      const inb = inbound[f * P + p];
      const outb = outbound[f * P + p];
      const rec = st.norm?.rec ?? 0;
      const expected = rec * share;
      const target = st.norm ? targetUnits(expected) : 0;
      const need = targetEligible && st.norm ? Math.max(0, target - stock - inb) : 0;
      const keep = st.norm ? Math.max(targetUnits(rec * shareDay), stock > 0 ? 1 : 0) : stock;
      const surplus = sourceEligible ? Math.max(0, Math.floor(stock - outb - keep)) : 0;
      const reason = !st.norm
        ? "нормы нет (мало данных) — не добавляем и не забираем"
        : need > 0
          ? `норма ${rec} шт./день, до ${fmt(end)} нужно ${target} шт., есть ${stock + inb} → добавить ${need} шт.`
          : surplus > 0
            ? `есть ${stock} шт., до конца дня себе ${keep} шт. → можно забрать ${surplus} шт.`
            : target > 0 && !targetEligible
              ? "сейчас продаж нет"
              : `есть ${stock + inb} шт., до ${fmt(end)} нужно ${target} шт. — хватает`;
      const cell: ProductCell = { f, p, stock, expected: r1(expected), target, need, keep, surplus, inbound: inb, outbound: outb, reason };
      products[f * P + p] = cell;
      perCat[catIdx.get(ctx.snap.products[p].categoryId)!].push(cell);
    }
    return ff.categories.map((cf, c) => {
      const list = perCat[c];
      const sum = (k: "stock" | "expected" | "need" | "surplus" | "keep" | "inbound" | "outbound") => list.reduce((a, x) => a + x[k], 0);
      const need = sum("need");
      const surplus = sum("surplus");
      const expected = sum("expected");
      const name = (x: ProductCell) => ctx.snap.products[x.p].name;
      const reason =
        need > 0
          ? `нужно ${need}: ${list.filter((x) => x.need > 0).sort((a, b) => b.need - a.need).slice(0, 4).map((x) => `${name(x)} +${x.need}`).join(", ")}`
          : surplus > 0
            ? `можно отдать ${surplus}: ${list.filter((x) => x.surplus > 0).sort((a, b) => b.surplus - a.surplus).slice(0, 4).map((x) => `${name(x)} ×${x.surplus}`).join(", ")}`
            : !targetEligible && !ff.isOpenNow
              ? "сейчас продаж нет"
              : "по каждому блюду хватает";
      return {
        stock: cf.stock,
        expected: r1(expected),
        safety: 0,
        projected: Math.round(cf.stock + sum("inbound") - expected),
        need,
        surplus,
        keep: sum("keep"),
        confidence: cf.confidence,
        critical: targetEligible && cf.expected2h >= 1 && cf.minutesToEmpty !== null && cf.minutesToEmpty <= ENGINE_CONFIG.conservative.criticalMinutes,
        targetEligible,
        sourceEligible,
        inbound: sum("inbound"),
        outbound: sum("outbound"),
        reason,
      };
    });
  });
  return { cells, products };
}
