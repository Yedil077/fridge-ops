import { ENGINE_CONFIG } from "../config/engine";
import type { Fridge, Weekday } from "../domain/types";
import { fmtHM, inCircularRange, isWeekend, weekdayOf } from "../time";
import { histDay, hourlyAt, type EngineContext } from "./history";

/**
 * OBSERVED ACTIVITY — when a fridge really sells, learned from sale timestamps (00:00–23:59, all 7 weekdays).
 * No assumption about "office hours": night, weekend and 24/7 points are learned the same way.
 * The configured schedule (Настройки) is only used when there is not enough history, and mismatches are reported.
 */

export interface ActiveRange {
  /** ISO weekday the range starts on */
  weekday: Weekday;
  /** minutes from that day's 00:00 */
  from: number;
  /** may exceed 1440 — the range continues after midnight */
  to: number;
}

export interface ActivityProfile {
  fridgeIndex: number;
  /** [weekday 0..6][hour 0..23] average units per calendar day of that weekday */
  avg: number[][];
  /** [weekday][hour] share of that weekday's days with ≥ 1 sale in the hour */
  freq: number[][];
  /** calendar days per weekday in the window (since the fridge started) */
  days: number[];
  /** [weekday][hour] observed active (or, for weekdays without enough history, configured schedule) */
  active: boolean[][];
  /** true when the weekday's activity comes from history, false = configured schedule fallback */
  learned: boolean[];
  ranges: ActiveRange[];
  /** units sold 22:00–06:00 / all units */
  nightShare: number;
  /** units sold on Sat + Sun / all units */
  weekendShare: number;
  /** hours with the highest average sales (0..23), best first */
  topHours: number[];
  /** up to two best 2-hour windows; `to` may exceed 24 (crosses midnight) */
  peaks: { from: number; to: number }[];
  /** hourly sales summed over all weekdays, average per day (0..23) */
  hourly: number[];
  /** configured "closed" but really active (from history) */
  mismatches: { weekday: Weekday; hours: number[] }[];
  totalUnits: number;
}

const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

/** Is the CONFIGURED schedule open at (weekday, hour)? Handles closing after midnight. */
export function scheduledAt(fr: Fridge, wd: Weekday, hour: number): boolean {
  const minute = hour * 60 + 30;
  const { openingMinute: o, closingMinute: c } = fr;
  const overnight = c <= o && c !== o;
  if (fr.workingDays.includes(wd) && (overnight ? minute >= o : inCircularRange(minute, o, c))) return true;
  // early hours belong to the previous day's overnight window
  const prev = (((wd + 5) % 7) + 1) as Weekday;
  return overnight && fr.workingDays.includes(prev) && minute < c;
}

const profileCache = new WeakMap<EngineContext, Map<number, ActivityProfile>>();

export function activityProfile(ctx: EngineContext, f: number): ActivityProfile {
  let cache = profileCache.get(ctx);
  if (!cache) profileCache.set(ctx, (cache = new Map()));
  const hit = cache.get(f);
  if (hit) return hit;

  const A = ENGINE_CONFIG.activity;
  const fr = ctx.snap.fridges[f];
  const sum = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const hits = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const days = new Array<number>(7).fill(0);
  for (let d = 0; d < ctx.D; d++) {
    const day = histDay(ctx, d);
    if (ctx.today - day > A.windowDays || day < fr.activeSinceDay || !fr.isActive) continue;
    const w = weekdayOf(day) - 1;
    days[w]++;
    for (let h = 0; h < 24; h++) {
      let v = 0;
      for (let c = 0; c < ctx.C; c++) v += hourlyAt(ctx, f, c, d, h);
      sum[w][h] += v;
      if (v > 0) hits[w][h]++;
    }
  }
  const avg = sum.map((row, w) => row.map((v) => (days[w] ? v / days[w] : 0)));
  const freq = hits.map((row, w) => row.map((v) => (days[w] ? v / days[w] : 0)));
  const learned = days.map((n) => n >= A.minDays);
  const active = avg.map((row, w) =>
    row.map((v, h) => (learned[w] ? freq[w][h] >= A.minFrequency && v >= A.minAvgUnits : scheduledAt(fr, (w + 1) as Weekday, h))),
  );

  // totals & shares (all hours, all days — nothing is cut)
  let total = 0;
  let night = 0;
  let weekend = 0;
  const hourly = new Array<number>(24).fill(0);
  const totalDays = days.reduce((a, b) => a + b, 0) || 1;
  for (let w = 0; w < 7; w++)
    for (let h = 0; h < 24; h++) {
      const units = sum[w][h];
      total += units;
      hourly[h] += units / totalDays;
      if (inCircularRange(h * 60, A.nightFrom, A.nightTo)) night += units;
      if (isWeekend((w + 1) as Weekday)) weekend += units;
    }

  const topHours = hourly
    .map((v, h) => ({ v, h }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v)
    .slice(0, 3)
    .map((x) => x.h);

  // best non-overlapping 2-hour windows on the circular day (23:00–01:00 is a valid peak)
  const win = hourly.map((v, h) => ({ h, v: v + hourly[(h + 1) % 24] })).sort((a, b) => b.v - a.v);
  const peaks: { from: number; to: number }[] = [];
  for (const x of win) {
    if (peaks.length >= 2 || x.v <= 0) break;
    if (peaks.some((p) => [0, 1, 23].includes((((x.h - p.from) % 24) + 24) % 24))) continue;
    if (peaks.length === 1 && x.v < win[0].v * 0.45) break;
    peaks.push({ from: x.h, to: x.h + 2 });
  }

  // contiguous active ranges on the circular week (Sat 22:00 → Sun 02:00 is ONE range)
  const week = active.flat(); // 168 hours, Mon 00:00 first
  const ranges: ActiveRange[] = [];
  if (week.every(Boolean)) {
    for (let w = 0; w < 7; w++) ranges.push({ weekday: (w + 1) as Weekday, from: 0, to: 1440 });
  } else {
    const start = week.findIndex((v, i) => !v && week[(i + 1) % 168]);
    for (let k = 1; k <= 168; k++) {
      const i = (start + k) % 168;
      if (!week[i] || week[(i + 167) % 168]) continue;
      let len = 0;
      while (len < 168 && week[(i + len) % 168]) len++;
      const w = Math.floor(i / 24);
      const h = i % 24;
      ranges.push({ weekday: (w + 1) as Weekday, from: h * 60, to: (h + len) * 60 });
    }
    ranges.sort((a, b) => a.weekday - b.weekday || a.from - b.from);
  }

  const mismatches: ActivityProfile["mismatches"] = [];
  for (let w = 0; w < 7; w++) {
    if (!learned[w]) continue;
    const hours = [];
    for (let h = 0; h < 24; h++) if (active[w][h] && !scheduledAt(fr, (w + 1) as Weekday, h)) hours.push(h);
    if (hours.length) mismatches.push({ weekday: (w + 1) as Weekday, hours });
  }

  const res: ActivityProfile = {
    fridgeIndex: f,
    avg,
    freq,
    days,
    active,
    learned,
    ranges,
    nightShare: total ? night / total : 0,
    weekendShare: total ? weekend / total : 0,
    topHours,
    peaks,
    hourly,
    mismatches,
    totalUnits: total,
  };
  cache.set(f, res);
  return res;
}

/** Active at minute `m` counted from TODAY's 00:00 (m ≥ 1440 = tomorrow). */
export function activeAt(p: ActivityProfile, today: number, m: number): boolean {
  const day = today + Math.floor(m / 1440);
  const h = Math.floor((((m % 1440) + 1440) % 1440) / 60);
  return p.active[weekdayOf(day) - 1][h];
}

/**
 * Current / upcoming activity window around `nowMinute`.
 * end = minutes from today's 00:00 (may cross midnight); 0 length when neither active nor starting soon.
 */
export function activityWindow(p: ActivityProfile, today: number, nowMinute: number) {
  const A = ENGINE_CONFIG.activity;
  const limit = nowMinute + 24 * 60;
  const activeNow = activeAt(p, today, nowMinute);
  let start: number | null = activeNow ? nowMinute : null;
  if (start === null) {
    for (let m = (Math.floor(nowMinute / 60) + 1) * 60; m < limit; m += 60)
      if (activeAt(p, today, m)) {
        start = m;
        break;
      }
  }
  let end = start ?? nowMinute;
  if (start !== null) {
    end = (Math.floor(start / 60) + 1) * 60;
    while (end < start + 24 * 60 && activeAt(p, today, end)) end += 60;
  }
  return {
    activeNow,
    /** next start (minutes from today 00:00), null if no activity within 24 h */
    nextStart: activeNow ? null : start,
    /** forecast window end: end of the current block, or of the block starting within `upcomingStartMinutes` */
    end: activeNow || (start !== null && start - nowMinute <= A.upcomingStartMinutes) ? end : nowMinute,
    blockEnd: end,
  };
}

export function fmtRange(r: ActiveRange): string {
  return `${WD[r.weekday - 1]} ${fmtHM(r.from)}–${r.to >= 1440 && r.to % 1440 === 0 && r.to - r.from >= 1440 ? "24:00" : fmtHM(r.to)}`;
}

export function fmtHourWindow(from: number, to: number): string {
  return `${fmtHM(from * 60)}–${fmtHM(to * 60)}`;
}
