/**
 * Domain types shared by the engine, the data sources and the UI.
 *
 * Time convention: every timestamp inside the system is "wall-clock ms" —
 * milliseconds where the UTC fields equal the local time of the fridges.
 * Conversion from real timezones happens only at the data-source boundary.
 */

export type CategoryId = "breakfast" | "hot" | "salad" | "snack" | "dessert" | "drink";

export type LocationType = "office" | "coworking" | "university" | "gym" | "hospital" | "residential";

/** ISO weekday: 1 = Monday … 7 = Sunday */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface Category {
  id: CategoryId;
  name: string;
  short: string;
  emoji: string;
  /** Shelf life in days — drives waste risk. */
  shelfLifeDays: number;
  /** Share of leftovers at close that becomes waste: [tomorrow open, tomorrow closed]. */
  wasteShare: [number, number];
  /** Categories not relevant for availability metrics (e.g. very long shelf life) can be excluded. */
  core: boolean;
}

export interface Product {
  id: string;
  externalId: string;
  name: string;
  categoryId: CategoryId;
  price: number;
  /** Short code shown to staff next to the dish name (SKU / label code). */
  sku: string;
  /** Photo of the dish if the source provides one. */
  imageUrl: string | null;
  /** Barcode / QR payload for future scanning. */
  barcode: string | null;
}

export interface Fridge {
  id: string;
  externalId: string;
  code: string; // "01"
  /** Real display name shown to staff, e.g. "Сатти 4" (editable in Admin). */
  name: string;
  /** Compact name for chips / narrow screens. */
  shortName: string;
  /** Manual importance: 1 low, 2 normal, 3 high — nudges target priority. */
  priority: 1 | 2 | 3;
  /** Fridges in the same proximity group are treated as "near" for routing. */
  proximityGroup: string | null;
  /** Food may move ONLY between fridges with the same transfer group (e.g. SATTI, KABLAN_KANKORD). null = no transfers. */
  transferGroup: string | null;
  location: string;
  locationType: LocationType;
  /**
   * CONFIGURED schedule (Настройки) — a hint only. Real activity is learned from sale timestamps;
   * sales outside this schedule are kept and reported as SCHEDULE MISMATCH.
   * closingMinute < openingMinute means the window continues after midnight (e.g. 18:00–02:00).
   */
  workingDays: Weekday[];
  openingMinute: number; // minutes from 00:00
  closingMinute: number;
  latitude: number | null;
  longitude: number | null;
  capacity: number;
  isActive: boolean;
  /** Closed on public holidays (office-type locations). */
  closedOnHolidays: boolean;
  /** Wall-clock day number when the fridge started operating (cold start). */
  activeSinceDay: number;
}

/**
 * History cube: sales aggregated by fridge × category × day × hour for past days,
 * plus product totals by fridge × product × day.
 * Indexes follow the order of `fridges`, `categories`, `products` in the snapshot.
 */
export interface HistoryCube {
  /** Wall-clock day number of index 0. */
  startDay: number;
  days: number;
  /** length = F * C * days * 24 */
  hourly: Float32Array;
  /** length = F * P * days */
  productDaily: Float32Array;
  /** Wall-clock day numbers that are public holidays (network-wide). */
  holidays: number[];
}

export const QUARTERS = 96;

export interface TodayState {
  day: number;
  /** Sales so far today by fridge × category × quarter-hour. length = F * C * 96 */
  quarterSales: Float32Array;
  /** Sales so far today by fridge × product. length = F * P */
  productSales: Float32Array;
  /** Quarters in which a category was out of stock (1 = stockout). length = F * C * 96 */
  stockoutQuarters: Uint8Array;
  /** Revenue so far per fridge. */
  revenue: Float32Array;
}

export interface NetworkSnapshot {
  /** wall-clock ms */
  now: number;
  fridges: Fridge[];
  categories: Category[];
  products: Product[];
  history: HistoryCube;
  today: TodayState;
  /** Current stock by fridge × product. length = F * P */
  stock: Int32Array;
  /** Travel minutes between fridges, F × F (manual matrix or from coordinates). */
  travelMinutes: number[][];
  /** Bumped every time underlying data changes (for caching). */
  version: string;
  source: "mock" | "kitshop";
}

// ───────────────────────── Engine outputs ─────────────────────────

export type RiskState = "EMPTY_RISK" | "LOW_STOCK" | "NORMAL" | "OVERSTOCK" | "WASTE_RISK" | "CLOSED";
export type FridgeStatus = "normal" | "attention" | "critical" | "closed";

export interface BaselineSource {
  label: string;
  sameWeekdaySamples: number;
  dayTypeSamples: number;
  networkWeight: number;
}

export interface CategoryForecast {
  fridgeIndex: number;
  categoryIndex: number;
  stock: number;
  /** Normal (historical) expected sales per hour for today, 24 values. */
  normalHourly: number[];
  /** Forecast per hour for today (normal × pace), 24 values. */
  forecastHourly: number[];
  salesToday: number;
  salesLastHour: number;
  salesLast2h: number;
  /** Units per hour at current forecast rate. */
  velocity: number;
  expected1h: number;
  expected2h: number;
  expectedUntilClose: number;
  interval1h: [number, number];
  interval2h: [number, number];
  intervalClose: [number, number];
  pace: number;
  rawPace: number;
  expectedSoFar: number;
  actualSoFar: number;
  confidence: number; // 0..1
  cv: number;
  trendFactor: number;
  monthFactor: number;
  bias: number;
  baseline: BaselineSource;
  /** forecast for the NEXT calendar day (24 values) — used by windows that cross midnight */
  tomorrowHourly: number[];
  /** Minutes until stock hits zero at forecast rate; null if it lasts until the end of the activity window. */
  minutesToEmpty: number | null;
  projected1h: number;
  projected2h: number;
  projectedClose: number;
  safetyStock: number;
  wasteUnits: number;
  state: RiskState;
}

export interface FridgeForecast {
  fridgeIndex: number;
  /** ACTIVE now by observed activity (sale history for this weekday/hour, or sales in the last hour) */
  isOpenNow: boolean;
  /** activity expected today (learned P(open) for this weekday, or already sold today) */
  isWorkingToday: boolean;
  isWorkingTomorrow: boolean;
  /** minutes until the current observed activity window ends (0 when not active) */
  minutesToClose: number;
  /** minutes until the next observed activity window starts (within 24 h), null if none */
  minutesToOpen: number | null;
  /** end of the current / upcoming activity window, minutes from today's 00:00 (may exceed 1440) */
  activityEndMinute: number;
  salesToday: number;
  revenueToday: number;
  pace: number;
  expectedSoFar: number;
  projectedDayTotal: number;
  typicalDayTotal: number;
  typicalDayStd: number;
  anomaly: null | { direction: "up" | "down"; deviationPct: number };
  categories: CategoryForecast[];
  totalStock: number;
  status: FridgeStatus;
  health: number; // 0..1
  confidence: number;
}

export interface DemandIndexRow {
  fridgeIndex: number;
  /** by category index; 1.00 = network average share */
  index: number[];
  share: number[];
}

export interface FridgePersonality {
  fridgeIndex: number;
  title: string;
  emoji: string;
  traits: { label: string; value: string; tone: "up" | "down" | "neutral" }[];
  peakWindow: { from: number; to: number } | null; // hours
  weekdayAvg: number[]; // Mon..Sun average daily sales (0 = closed)
  hourlyAvg: number[]; // 24
  categoryShare: number[];
  demandIndex: number[];
  trend: { categoryIndex: number; sixMonthsAgo: number; threeMonthsAgo: number; last30: number; changePct: number }[];
  topProducts: { productIndex: number; perDay: number }[];
  weakProducts: { productIndex: number; perDay: number }[];
  dataDays: number;
  coldStart: boolean;
}

// ───────────────────────── Missions ─────────────────────────

export type MissionStatus = "NEW" | "ACCEPTED" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED" | "EXPIRED";
export type MissionType = "URGENT" | "RESCUE" | "REBALANCE";
/** What staff see instead of a score: 🔴 now · 🟡 today · 🟢 later */
export type MissionUrgency = "NOW" | "TODAY" | "LATER";
/**
 * Forecast horizon chosen by the user. Always starts at the CURRENT time, any time of day (crosses midnight):
 *  • realtime — next ~90 min (REAL TIME)
 *  • h1 / h2  — next 1 / 2 hours
 *  • until20  — until the clock time set in Настройки (default 20:00; id kept for compatibility, shown as "ДО HH:MM").
 *               A pure user mode — once that time has passed it is reported as "horizon passed".
 *  • activity — until the end of the fridge's OBSERVED activity (learned from real sale timestamps)
 */
export type ForecastMode = "realtime" | "h1" | "h2" | "until20" | "activity";

export const FORECAST_MODE_IDS: ForecastMode[] = ["realtime", "h1", "h2", "until20", "activity"];

export interface MissionProduct {
  productId: string;
  name: string;
  sku: string;
  qty: number;
  /** Chosen at pick-up (may be less than qty — partial moves are normal). */
  selectedQty?: number | null;
  /** Actually delivered (null until done). */
  actualQty: number | null;
  /** Optional reason when the dish was skipped: no_stock | not_needed | low_left | other */
  skipReason?: string | null;
  /** Fridge × product affinity 0–100 at the target (why this dish goes there). */
  targetAffinity: number;
  sourceAffinity: number;
  /** Average sales per working day of this dish at target / source (last 90 days). */
  targetPerDay: number;
  sourcePerDay: number;
}

export interface MissionStop {
  targetFridgeId: string;
  /** Minutes from the previous point of the route. */
  travelMinutes: number;
  deliveredAt: number | null;
}

export interface ExplanationLine {
  label: string;
  value: string;
  emphasis?: boolean;
}

export interface MissionLine {
  categoryId: CategoryId;
  /** Stop of the route this line is delivered to. */
  targetFridgeId: string;
  recommendedQty: number;
  qtyRange: [number, number];
  actualQty: number | null;
  products: MissionProduct[];
  expectedShortage: number;
  expectedSurplus: number;
  sourceWasteUnits: number;
  targetStockBefore: number;
  sourceStockBefore: number;
  predictedTargetSales2h: number;
  confidence: number;
  why: {
    summary: string;
    /** 2–4 short plain sentences for the phone. */
    short: string[];
    target: ExplanationLine[];
    source: ExplanationLine[];
    decision: ExplanationLine[];
  };
  scores: { shortage: number; waste: number; opportunity: number; urgency: number; distance: number; pair: number };
}

export interface MissionEvaluation {
  evaluatedAt: number;
  lines: {
    categoryId: CategoryId;
    targetFridgeId: string;
    moved: number;
    salesInWindow: number;
    soldAttributed: number;
    predicted: number;
    successRate: number;
    accuracy: number;
  }[];
  result: "EXCELLENT" | "GOOD" | "WEAK" | "POOR";
  successRate: number;
  accuracy: number;
  preventedEmpty: boolean;
  preventedWaste: boolean;
}

export interface Mission {
  id: string;
  number: number;
  createdAt: number;
  analysisAt: number;
  status: MissionStatus;
  type: MissionType;
  title: string;
  priority: number;
  priorityLabel: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  urgency: MissionUrgency;
  /** Forecast horizon the mission was computed for. */
  mode?: ForecastMode;
  /** actual moved ÷ recommended (set on completion) — feeds transfer aggressiveness learning. */
  acceptance?: number | null;
  /** A mission is a ROUTE: one pick-up fridge, one or more drop-off stops (ordered). */
  sourceFridgeId: string;
  /** First stop (kept for simple views). */
  targetFridgeId: string;
  stops: MissionStop[];
  /** Total route travel time. */
  travelMinutes: number;
  lines: MissionLine[];
  headline: string;
  effect: ExplanationLine[];
  /** Display names resolved at read time (Admin can rename fridges). */
  sourceName?: string;
  stopNames?: Record<string, string>;
  acceptedAt: number | null;
  acceptedBy: string | null;
  startedAt: number | null;
  completedAt: number | null;
  completedBy: string | null;
  skippedAt: number | null;
  skipReason: string | null;
  evaluation: MissionEvaluation | null;
  xpAwarded: number;
  pointsAwarded: number;
}
