import { ENGINE_CONFIG } from "../config/engine";
import type { ForecastMode, FridgeForecast } from "../domain/types";
import { sumAcross } from "./forecast";
import type { EngineContext } from "./history";

/**
 * DEMAND — the ONE source of truth for "how much is needed / how much can be given".
 * The fridge profile, the transfer recommendations and every screen read these numbers; nothing else computes them.
 *
 * Two horizons: NOW (~90 min from now) and UNTIL_EVENING (until the time in Настройки, default 20:00).
 * For one shop × category × horizon:
 *   expected_demand = forecast for [now, end)  (fridge's own profile × today's pace × trend)
 *   projected_stock = current_stock + already promised in − expected_demand
 *   need_quantity   = ceil(expected_demand + safety_stock − (current_stock + promised in)),
 *                     only if the fridge is active now and the demand in the window is real (≥ minDemandInWindow)
 *   keep            = max(expected_demand_upper + safety_stock, minimum display stock,
 *                         NOW: half of the demand until the end of today's activity)
 *   safe_surplus    = floor(current_stock − promised out − keep)   (≤ 0 → the shop cannot be a source)
 * A shop never needs and gives the same category at the same time.
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
  /** one plain sentence: why this need / surplus */
  reason: string;
}

/** Window end for a horizon: [now, end); may pass midnight. "ДО ВЕЧЕРА" after that time falls back to NOW. */
export function horizonEnd(h: Horizon, nowMinute: number, untilMinute: number): number {
  const realtime = nowMinute + ENGINE_CONFIG.transfer.realtimeHorizonMinutes;
  if (h === "UNTIL_EVENING") return untilMinute > nowMinute ? untilMinute : realtime;
  return realtime;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

export function demandGrid(
  ctx: EngineContext,
  forecasts: FridgeForecast[],
  opts: { horizon: Horizon; untilMinute: number; promised?: Promised[] },
): DemandCell[][] {
  const T = ENGINE_CONFIG.transfer;
  const K = ENGINE_CONFIG.conservative;
  const inbound = forecasts.map(() => new Array<number>(ctx.C).fill(0));
  const outbound = forecasts.map(() => new Array<number>(ctx.C).fill(0));
  for (const r of opts.promised ?? []) {
    inbound[r.targetIndex][r.categoryIndex] += r.qty;
    outbound[r.sourceIndex][r.categoryIndex] += r.qty;
  }
  const end = horizonEnd(opts.horizon, ctx.nowMinute, opts.untilMinute);
  return forecasts.map((ff, f) =>
    ff.categories.map((cf, c) => {
      const cat = ctx.snap.categories[c];
      const targetEligible = ff.isOpenNow && ff.minutesToClose >= T.minTargetOpenMinutes;
      const sourceEligible = ff.isOpenNow || (T.allowClosedSource && ff.isWorkingToday);
      const expected = sumAcross(cf.forecastHourly, cf.tomorrowHourly, ctx.nowMinute, end);
      const stockIn = cf.stock + inbound[f][c];
      const demandOk = expected >= K.minDemandInWindow;
      const need = targetEligible && demandOk ? Math.max(0, Math.ceil(expected + cf.safetyStock - stockIn)) : 0;
      const upper = expected * (1 + (1 - cf.confidence) * 0.5);
      const minDisplay = K.minDisplayStock[cat.id];
      const keep = Math.max(upper + cf.safetyStock, minDisplay, opts.horizon === "NOW" ? 0.5 * cf.expectedUntilClose : 0);
      const rawSurplus = sourceEligible ? Math.max(0, Math.floor(cf.stock - outbound[f][c] - keep)) : 0;
      const surplus = need > 0 ? 0 : rawSurplus;
      const critical = targetEligible && cf.expected2h >= 1 && cf.minutesToEmpty !== null && cf.minutesToEmpty <= K.criticalMinutes;
      const reason =
        need > 0
          ? `есть ${stockIn}, до ${fmt(end)} обычно продаётся ~${r1(expected)} + запас ${r1(cf.safetyStock)} → нужно ${need}`
          : surplus > 0
            ? `есть ${cf.stock}, себе оставляем ${Math.ceil(keep)} (продажи до ${fmt(end)} с запасом и минимум на витрине) → можно отдать ${surplus}`
            : !targetEligible && !ff.isOpenNow
              ? "сейчас продаж обычно нет"
              : !demandOk
                ? `до ${fmt(end)} спроса почти нет (~${r1(expected)})`
                : `есть ${cf.stock}, до ${fmt(end)} обычно ~${r1(expected)} — хватает`;
      return {
        stock: cf.stock,
        expected: r1(expected),
        safety: r1(cf.safetyStock),
        projected: Math.round(stockIn - expected),
        need,
        surplus,
        keep,
        confidence: cf.confidence,
        critical,
        targetEligible,
        sourceEligible,
        inbound: inbound[f][c],
        outbound: outbound[f][c],
        reason,
      };
    }),
  );
}

function fmt(m: number): string {
  const x = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
}

/**
 * Dish level, same formulas split by the dish's share in the category at that shop:
 *   product need    = ceil(expected × share + safety × share − (stock + already sent))
 *   product surplus = min(perProductCap, floor(stock − max(keep × share, minimum kept of that dish)))
 * The source always keeps 1–2 of every dish (variety); its last units move only for a critical shortage.
 */
export function productNeed(cell: DemandCell, share: number, have: number): number {
  return Math.ceil(cell.expected * share + cell.safety * share - have);
}

export function productSurplus(sourceCell: DemandCell, share: number, stock: number, critical: boolean): number {
  const K = ENGINE_CONFIG.conservative;
  const minKeep = stock <= 0 ? 0 : critical ? 1 : stock >= K.plentyThreshold ? K.minKeepPerProductWhenPlenty : K.minKeepPerProduct;
  const cap = critical ? K.maxPerProductCritical : K.maxPerProduct;
  return Math.min(cap, Math.floor(stock - Math.max(sourceCell.keep * share, minKeep)));
}
