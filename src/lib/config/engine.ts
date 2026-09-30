/**
 * Every tunable parameter of the recommendation model lives here.
 * Changing a number here changes behaviour everywhere — no magic constants in the engine.
 */
export const ENGINE_CONFIG = {
  /** How often the hourly analysis runs (also "time until next check"). */
  analysisIntervalMinutes: 60,
  /** Horizon for shortage risk. */
  riskHorizonMinutes: 120,

  history: {
    /** Recency buckets for weighted history (age in days, weight). */
    recencyBuckets: [
      { maxAgeDays: 7, weight: 0.4 },
      { maxAgeDays: 30, weight: 0.3 },
      { maxAgeDays: 90, weight: 0.2 },
      { maxAgeDays: 180, weight: 0.1 },
    ],
    /** Shrinkage strength for same-weekday samples (A level). */
    sameWeekdayK: 4,
    /** Shrinkage strength for same day-type samples (B level). */
    dayTypeK: 6,
    /** Outlier cap: sample > median × cap → capped (needs ≥ 4 samples). */
    outlierCapRatio: 1.8,
    /** Trend correction: last N days vs weighted mean. */
    trendWindowDays: 28,
    trendMin: 0.85,
    trendMax: 1.2,
    /** Month phase correction bounds. */
    monthPhaseMin: 0.92,
    monthPhaseMax: 1.08,
    /** Days with same weekday needed for full data confidence (12 ≈ 3 months). */
    fullConfidenceSamples: 12,
  },

  pace: {
    /** Units of expected sales that make pace fully trusted (shrinkage). */
    strength: 8,
    min: 0.5,
    max: 1.8,
    /** How strongly pace moves the forecast (1 = fully). */
    weight: 0.8,
  },

  anomaly: {
    sigma: 2.5,
    paceUp: 1.35,
    paceDown: 0.65,
    /** Minimal expected sales so far before anomaly can trigger. */
    minExpectedSoFar: 6,
    confidencePenalty: 0.8,
  },

  risk: {
    minSafetyUnits: 2,
    /** safety = max(minSafetyUnits, expected1h × safetyHours) */
    safetyHours: 0.5,
    overstockRatio: 1.8,
    overstockMinUnits: 4,
    wasteMinUnits: 3,
  },

  transfer: {
    /** REAL TIME mode: look this far ahead (≈ until the next check). */
    realtimeHorizonMinutes: 90,
    /* "ДО ЗАКРЫТИЯ" mode forecasts until each fridge's closing time from Настройки. */
    /** Target may absorb up to this share of its expected sales until close. */
    absorbRatio: 0.8,
    /** Target must stay open at least this long after the transfer. */
    minTargetOpenMinutes: 60,
    /** Source keeps enough for next check + safety, or its expected sales until close. */
    sourceKeepCloseRatio: 1.0,
    allowClosedSource: false,
    minQty: 2,
    /** qty × (confidenceFloor + (1 − confidenceFloor) × confidence) */
    confidenceFloor: 0.6,
    /** A route = one pick-up fridge + up to maxStopsPerRoute drop-off fridges. */
    maxRoutes: 4,
    maxStopsPerRoute: 3,
    /** Priority bonus for adding a stop to an already chosen route (one trip instead of two). */
    sameRouteBonus: 1.1,
    /** A NEW stop is added to a route only if it is worth the walk. */
    minStopPriority: 45,
    /** A new stop must be within this walk from the pick-up or an existing stop… */
    maxAddStopMinutes: 15,
    /** …and the whole route must stay under this. */
    maxRouteMinutes: 35,
    /** Long-life categories (drinks) are moved only in meaningful amounts. */
    minQtyNonCore: 4,
    /** A target category can be fed by at most this many sources; extra sources must bring ≥ extraSourceMinQty. */
    maxSourcesPerTarget: 2,
    extraSourceMinQty: 4,
    minPriority: 35,
  },

  /**
   * Conservative distribution: "what is the SMALLEST move now that removes the empty-shelf risk
   * while the source keeps a good assortment?" Small frequent adjustments, every hour.
   */
  conservative: {
    /** Never leave fewer than this many units of a category in the source. */
    minDisplayStock: { breakfast: 2, hot: 3, salad: 2, snack: 2, dessert: 2, drink: 2 },
    /** Variety: keep at least 1 unit of every dish in the source (2 if it has ≥ plentyThreshold). */
    minKeepPerProduct: 1,
    minKeepPerProductWhenPlenty: 2,
    plentyThreshold: 4,
    /** Caps per recommendation (higher only for a CRITICAL shortage). */
    maxPerProduct: 2,
    maxPerProductCritical: 3,
    maxPerCategory: 4,
    maxPerCategoryCritical: 6,
    /** One route should be easy to carry. */
    maxItemsPerRoute: 12,
    /** No move for a category with less expected demand than this in the forecast window. */
    minDemandInWindow: 0.8,
    /** Target runs empty within this many minutes → critical. */
    criticalMinutes: 45,
    /** Learning from what people actually move (acceptance = moved ÷ recommended). */
    acceptanceMinMissions: 3,
    acceptanceTarget: 0.8,
    acceptanceFloor: 0.5,
    acceptanceRate: 0.3,
  },

  priority: {
    weights: { shortage: 0.35, waste: 0.25, opportunity: 0.25, urgency: 0.15 },
    wasteNormUnits: 6,
    opportunityNormUnits: 8,
    urgencyHorizonHours: 3,
    /** priority × (confidenceBase + (1 − confidenceBase) × confidence) */
    confidenceBase: 0.7,
    labels: { critical: 80, high: 60, medium: 40 },
    /** What staff see: NOW ≥ now, TODAY ≥ today, otherwise LATER. */
    urgency: { now: 70, today: 45, nowMinutesToEmpty: 90 },
  },

  distance: {
    /** factor = clamp(bonus − perMinute × minutes, min, bonus) */
    bonus: 1.1,
    perMinute: 0.012,
    minFactor: 0.5,
    maxTravelMinutes: 45,
    /** For coordinates: walking/driving speed (km/h) + fixed overhead. */
    speedKmh: 18,
    overheadMinutes: 4,
    /** Two fridges in the same proximity group are at most this far apart. */
    nearMinutes: 5,
  },

  learning: {
    /** Prior success rate for an unseen route. */
    pairPrior: 0.75,
    pairPriorWeight: 3,
    pairFactorMin: 0.6,
    pairFactorMax: 1.15,
    /** EWMA learning rate for forecast bias. */
    biasRate: 0.2,
    biasMin: 0.6,
    biasMax: 1.4,
    evaluationWindowMinutes: 120,
  },

  score: {
    /** Daily score weights. */
    weights: { availability: 0.4, waste: 0.25, balance: 0.25, missions: 0.1 },
    balanceLow: 0.8,
    balanceHigh: 1.6,
  },

  /**
   * XP — for doing the work. OPS POINTS — only for a CONFIRMED result (checked 2 h later),
   * so points (and prizes) can never be farmed by clicking "done".
   */
  xp: {
    missionCompleted: 50,
    urgentBonus: 30,
    perfectQuantity: 20,
    fullRoute: 50,
    preventedStockout: 40,
    reducedWaste: 40,
    excellentResult: 30,
    dayCompleted: 100,
    /** Day bonus needs ≥ this share of taken missions completed, and at least minMissions. */
    dayCompletedRate: 0.9,
    dayCompletedMinMissions: 3,
    /** Urgent route completed within this many minutes of creation → Fast Response. */
    fastResponseMinutes: 20,
  },

  /** Reward milestones by lifetime OPS POINTS. Unlocking only notifies; an admin confirms the handover. */
  rewards: [
    { id: "small", points: 1000, title: "Маленький приз" },
    { id: "medium", points: 3000, title: "Приз побольше" },
    { id: "big", points: 5000, title: "Большой приз" },
  ],

  achievements: [
    { id: "firefighter", emoji: "🔥", title: "Firefighter", description: "Предотвратили 10 stockout горячих блюд", target: 10 },
    { id: "waste-saver", emoji: "♻️", title: "Waste Saver", description: "Спасли 50 позиций от возможного списания", target: 50 },
    { id: "perfect-route", emoji: "🎯", title: "Perfect Route", description: "5 точных маршрутов подряд", target: 5 },
    { id: "fast-response", emoji: "⚡", title: "Fast Response", description: "Срочная задача выполнена быстро", target: 1 },
  ],
} as const;

export type EngineConfig = typeof ENGINE_CONFIG;
