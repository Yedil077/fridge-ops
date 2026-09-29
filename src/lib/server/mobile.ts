import "server-only";
import { ENGINE_CONFIG } from "../config/engine";
import { CATEGORIES, CATEGORY_COLORS } from "../domain/categories";
import type { CategoryId, ForecastMode, Mission, NetworkSnapshot } from "../domain/types";
import { inMode } from "./views";
import type { AnalysisResult } from "../engine/analysis";
import { dailyScore, levelInfo } from "../engine/scoring";
import type { AppState } from "../store/appStore";
import { DAY_MS, dayNumber, fmtDuration, fmtHM, minuteOfDay } from "../time";

/**
 * Mobile view models — only what a person walking between fridges needs:
 * where to go, what to take (real dish names), how many, where to put it, how urgent.
 * No analytics here, so the phone stays fast.
 */

export interface MobileItem {
  lineIndex: number;
  productId: string;
  name: string;
  sku: string;
  /** barcode / QR payload for future camera verification */
  barcode: string | null;
  qty: number;
  actualQty: number | null;
  categoryId: CategoryId;
  categoryName: string;
  emoji: string;
  color: string;
  /** why this dish goes to this stop, e.g. "в Сатти 2 продаётся 6,8/день" */
  hint: string | null;
}

export interface MobileStop {
  fridgeId: string;
  name: string;
  location: string;
  travelMinutes: number;
  deliveredAt: number | null;
  items: MobileItem[];
}

export interface MobileRoute {
  id: string;
  number: number;
  status: Mission["status"];
  urgency: Mission["urgency"];
  type: Mission["type"];
  priority: number;
  sourceId: string;
  sourceName: string;
  sourceLocation: string;
  stops: MobileStop[];
  totalItems: number;
  travelMinutes: number;
  headline: string;
  why: string[];
  details: { stop: string; category: string; lines: { label: string; value: string }[] }[];
  acceptedBy: string | null;
  completedAt: number | null;
  xpAwarded: number;
  pointsAwarded: number;
  evaluation: Mission["evaluation"];
}

const r1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString("ru-RU");

export function mobileRoute(m: Mission, snap: NetworkSnapshot): MobileRoute {
  const fr = new Map(snap.fridges.map((f) => [f.id, f]));
  const barcodes = new Map(snap.products.map((p) => [p.id, p.barcode]));
  const src = fr.get(m.sourceFridgeId);
  const stops: MobileStop[] = m.stops.map((s) => {
    const t = fr.get(s.targetFridgeId);
    const items: MobileItem[] = [];
    m.lines.forEach((l, li) => {
      if ((l.targetFridgeId ?? m.targetFridgeId) !== s.targetFridgeId) return;
      const cat = CATEGORIES.find((c) => c.id === l.categoryId)!;
      for (const p of l.products) {
        items.push({
          lineIndex: li,
          productId: p.productId,
          name: p.name,
          sku: p.sku,
          barcode: barcodes.get(p.productId) ?? null,
          qty: p.qty,
          actualQty: p.actualQty,
          categoryId: l.categoryId,
          categoryName: cat.name,
          emoji: cat.emoji,
          color: CATEGORY_COLORS[l.categoryId],
          hint:
            p.targetPerDay > p.sourcePerDay * 1.2 && p.targetPerDay >= 0.5
              ? `в ${t?.name ?? ""} продаётся ${r1(p.targetPerDay)}/день, в ${src?.name ?? ""} — ${r1(p.sourcePerDay)}`
              : null,
        });
      }
    });
    return {
      fridgeId: s.targetFridgeId,
      name: t?.name ?? s.targetFridgeId,
      location: t?.location ?? "",
      travelMinutes: s.travelMinutes,
      deliveredAt: s.deliveredAt,
      items,
    };
  });
  const lead = m.lines[0];
  return {
    id: m.id,
    number: m.number,
    status: m.status,
    urgency: m.urgency ?? "TODAY",
    type: m.type,
    priority: m.priority,
    sourceId: m.sourceFridgeId,
    sourceName: src?.name ?? m.sourceFridgeId,
    sourceLocation: src?.location ?? "",
    stops,
    totalItems: stops.reduce((a, s) => a + s.items.reduce((x, i) => x + i.qty, 0), 0),
    travelMinutes: m.travelMinutes,
    headline: m.headline,
    why: lead?.why.short ?? [],
    details: m.lines.map((l) => ({
      stop: fr.get(l.targetFridgeId)?.name ?? l.targetFridgeId,
      category: CATEGORIES.find((c) => c.id === l.categoryId)?.name ?? l.categoryId,
      lines: [...l.why.target, ...l.why.source.slice(-2)].map((x) => ({ label: x.label, value: x.value })),
    })),
    acceptedBy: m.acceptedBy,
    completedAt: m.completedAt,
    xpAwarded: m.xpAwarded,
    pointsAwarded: m.pointsAwarded ?? 0,
    evaluation: m.evaluation,
  };
}

const URGENCY_ORDER = { NOW: 0, TODAY: 1, LATER: 2 } as const;

function openRoutes(state: AppState, snap: NetworkSnapshot, user: string, mode: ForecastMode): MobileRoute[] {
  return state.missions
    .filter((m) => inMode(m, mode))
    .sort((a, b) => {
      const mineA = a.acceptedBy === user && a.status !== "NEW" ? 0 : 1;
      const mineB = b.acceptedBy === user && b.status !== "NEW" ? 0 : 1;
      if (mineA !== mineB) return mineA - mineB;
      const u = URGENCY_ORDER[a.urgency ?? "TODAY"] - URGENCY_ORDER[b.urgency ?? "TODAY"];
      return u !== 0 ? u : b.priority - a.priority;
    })
    .map((m) => mobileRoute(m, snap));
}

function todayStats(state: AppState, snap: NetworkSnapshot, user: string) {
  const day = snap.today.day;
  const todays = state.missions.filter((m) => dayNumber(m.createdAt) === day);
  const taken = todays.filter((m) => m.acceptedAt !== null);
  const done = todays.filter((m) => m.status === "COMPLETED");
  const evaluated = done.filter((m) => m.evaluation);
  const events = state.xpEvents.filter((e) => e.user === user && dayNumber(e.at) === day);
  return {
    xpToday: events.reduce((a, e) => a + e.amount, 0),
    pointsToday: events.reduce((a, e) => a + (e.points ?? 0), 0),
    done: done.length,
    total: Math.max(taken.length, done.length),
    accuracy: evaluated.length ? evaluated.reduce((a, m) => a + m.evaluation!.accuracy, 0) / evaluated.length : null,
    myDone: done.filter((m) => m.completedBy === user).length,
  };
}

export function mobileHome(snap: NetworkSnapshot, a: AnalysisResult, state: AppState, user: string, mode: string, forecastMode: ForecastMode = "realtime") {
  const counts = { normal: 0, attention: 0, critical: 0, closed: 0 };
  for (const f of a.forecasts) counts[f.status]++;
  const p = state.players[user];
  return {
    now: snap.now,
    mode,
    counts,
    forecastMode,
    routes: openRoutes(state, snap, user, forecastMode),
    today: todayStats(state, snap, user),
    player: { name: user, ...levelInfo(p?.xp ?? 0), points: p?.points ?? 0, streak: p?.streak ?? 0 },
    lastAnalysisAt: state.lastAnalysisAt,
  };
}

export function mobileTasks(snap: NetworkSnapshot, state: AppState, user: string, forecastMode: ForecastMode = "realtime") {
  const day = snap.today.day;
  const done = state.missions
    .filter((m) => (m.status === "COMPLETED" || m.status === "SKIPPED") && dayNumber(m.createdAt) === day)
    .sort((x, y) => (y.completedAt ?? y.skippedAt ?? 0) - (x.completedAt ?? x.skippedAt ?? 0))
    .map((m) => mobileRoute(m, snap));
  return { now: snap.now, forecastMode, open: openRoutes(state, snap, user, forecastMode), done };
}

const STATUS_NOTE: Record<string, string> = {
  EMPTY_RISK: "скоро закончится",
  LOW_STOCK: "мало",
  WASTE_RISK: "риск списания",
  OVERSTOCK: "избыток",
};

export function mobileFridges(snap: NetworkSnapshot, a: AnalysisResult) {
  return {
    now: snap.now,
    fridges: a.forecasts
      .map((ff) => {
        const f = snap.fridges[ff.fridgeIndex];
        const worst = ff.categories
          .filter((c) => c.state !== "NORMAL" && c.state !== "CLOSED" && CATEGORIES[c.categoryIndex].core)
          .sort((x, y) => (x.state === "EMPTY_RISK" ? -1 : y.state === "EMPTY_RISK" ? 1 : 0))[0];
        return {
          id: f.id,
          name: f.name,
          location: f.location,
          status: ff.status,
          totalStock: ff.totalStock,
          salesToday: ff.salesToday,
          note: !ff.isOpenNow
            ? ff.isWorkingToday
              ? `работает ${fmtHM(f.openingMinute)}–${fmtHM(f.closingMinute)}`
              : "сегодня выходной"
            : worst
              ? `${CATEGORIES[worst.categoryIndex].emoji} ${CATEGORIES[worst.categoryIndex].name.toLowerCase()}: ${STATUS_NOTE[worst.state]}`
              : "всё в порядке",
        };
      })
      .sort((x, y) => {
        const order = { critical: 0, attention: 1, normal: 2, closed: 3 } as const;
        return order[x.status] - order[y.status] || x.name.localeCompare(y.name, "ru", { numeric: true });
      }),
  };
}

export function mobileFridge(snap: NetworkSnapshot, a: AnalysisResult, id: string) {
  const f = snap.fridges.findIndex((x) => x.id === id);
  if (f < 0) return null;
  const fr = snap.fridges[f];
  const ff = a.forecasts[f];
  const P = snap.products.length;
  return {
    now: snap.now,
    id: fr.id,
    name: fr.name,
    location: fr.location,
    status: ff.status,
    hours: `${fmtHM(fr.openingMinute)}–${fmtHM(fr.closingMinute)}`,
    isOpenNow: ff.isOpenNow,
    salesToday: ff.salesToday,
    categories: ff.categories
      .map((cf) => {
        const cat = CATEGORIES[cf.categoryIndex];
        const products = snap.products
          .map((p, pi) => ({ id: p.id, name: p.name, sku: p.sku, qty: snap.stock[f * P + pi], categoryId: p.categoryId }))
          .filter((p) => p.categoryId === cat.id && p.qty > 0)
          .sort((x, y) => y.qty - x.qty);
        return {
          id: cat.id,
          name: cat.name,
          emoji: cat.emoji,
          color: CATEGORY_COLORS[cat.id],
          stock: cf.stock,
          state: cf.state,
          note:
            cf.minutesToEmpty !== null && cf.minutesToEmpty <= 180 && cf.expected2h >= 1
              ? cf.minutesToEmpty === 0
                ? "закончилось"
                : `хватит ~${fmtDuration(cf.minutesToEmpty)}`
              : cf.state === "WASTE_RISK"
                ? `~${Math.round(cf.wasteUnits)} шт. могут уйти в списание`
                : cf.state === "OVERSTOCK"
                  ? "больше, чем продастся сегодня"
                  : null,
          products,
        };
      })
      .filter((c) => c.stock > 0 || c.note),
  };
}

export function mobileRating(snap: NetworkSnapshot, a: AnalysisResult, state: AppState, user: string) {
  const p = state.players[user];
  const day = snap.today.day;
  const weekStart = day - 6;
  const events = state.xpEvents.filter((e) => e.user === user);
  const score = dailyScore(snap, a.forecasts, state.missions);
  const todaysDone = state.missions.filter((m) => m.status === "COMPLETED" && dayNumber(m.createdAt) === day);
  const evaluated = todaysDone.filter((m) => m.evaluation);
  const points = p?.points ?? 0;
  const counters = p?.counters ?? { hotStockoutsPrevented: 0, wasteSaved: 0, perfectRoutesInRow: 0, fastUrgent: 0 };
  const progress: Record<string, number> = {
    firefighter: counters.hotStockoutsPrevented,
    "waste-saver": counters.wasteSaved,
    "perfect-route": counters.perfectRoutesInRow,
    "fast-response": counters.fastUrgent,
  };
  return {
    now: snap.now,
    player: {
      name: user,
      ...levelInfo(p?.xp ?? 0),
      points,
      pointsToday: events.filter((e) => dayNumber(e.at) === day).reduce((x, e) => x + (e.points ?? 0), 0),
      pointsWeek: events.filter((e) => dayNumber(e.at) >= weekStart).reduce((x, e) => x + (e.points ?? 0), 0),
      xpToday: events.filter((e) => dayNumber(e.at) === day).reduce((x, e) => x + e.amount, 0),
      streak: p?.streak ?? 0,
      bestStreak: p?.bestStreak ?? 0,
    },
    team: {
      score: score.total,
      stockoutsPrevented: evaluated.reduce((x, m) => x + m.evaluation!.lines.filter((l, i) => l.salesInWindow > m.lines[i].targetStockBefore).length, 0),
      wastePrevented: evaluated.reduce((x, m) => x + m.evaluation!.lines.reduce((y, l, i) => y + Math.min(l.soldAttributed, Math.round(m.lines[i].sourceWasteUnits)), 0), 0),
      completed: todaysDone.length,
      availability: score.availability,
    },
    achievements: ENGINE_CONFIG.achievements.map((x) => ({
      id: x.id,
      emoji: x.emoji,
      title: x.title,
      description: x.description,
      target: x.target,
      progress: Math.min(x.target, progress[x.id] ?? 0),
      unlockedAt: p?.achievements[x.id] ?? null,
    })),
    rewards: ENGINE_CONFIG.rewards.map((r) => {
      const claim = state.rewardClaims.find((c) => c.user === user && c.milestoneId === r.id);
      return { id: r.id, title: r.title, points: r.points, unlocked: !!claim, issued: !!claim?.issuedAt };
    }),
    recent: events
      .slice(-12)
      .reverse()
      .map((e) => ({ at: e.at, amount: e.amount, points: e.points ?? 0, reason: e.reason })),
    dayStart: day * DAY_MS,
    minute: minuteOfDay(snap.now),
  };
}

export type MobileHome = ReturnType<typeof mobileHome>;
export type MobileTasks = ReturnType<typeof mobileTasks>;
export type MobileFridges = ReturnType<typeof mobileFridges>;
export type MobileFridge = NonNullable<ReturnType<typeof mobileFridge>>;
export type MobileRating = ReturnType<typeof mobileRating>;
