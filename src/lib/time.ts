import type { Weekday } from "./domain/types";

/** Wall-clock helpers. All timestamps are "UTC fields = local time". */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function dayNumber(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

export function dayStart(day: number): number {
  return day * DAY_MS;
}

export function minuteOfDay(ms: number): number {
  return Math.floor((ms - dayNumber(ms) * DAY_MS) / MINUTE_MS);
}

/** ISO weekday of a day number. Day 0 (1970-01-01) was a Thursday. */
export function weekdayOf(day: number): Weekday {
  return ((((day + 3) % 7) + 7) % 7 + 1) as Weekday;
}

export function dayOfMonth(day: number): number {
  return new Date(day * DAY_MS).getUTCDate();
}

export function daysInMonth(day: number): number {
  const d = new Date(day * DAY_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

export function isWeekend(wd: Weekday): boolean {
  return wd >= 6;
}

/** Current wall-clock ms for a given IANA timezone. */
export function wallClockNow(timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

/** Is `minute` (0–1439) inside [from, to)? Handles windows across midnight, e.g. 18:00–02:00 (from > to). */
export function inCircularRange(minute: number, from: number, to: number): boolean {
  const m = ((minute % 1440) + 1440) % 1440;
  if (from === to) return true; // 24 h
  return from < to ? m >= from && m < to : m >= from || m < to;
}

/** Length of [from, to) in minutes; `to` before `from` means the window continues after midnight. */
export function circularLength(from: number, to: number): number {
  return to > from ? to - from : 1440 - from + to;
}

export function fmtHM(minute: number): string {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function fmtDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} ч ${r} мин` : `${h} ч`;
}

const WEEKDAY_SHORT = ["", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const WEEKDAY_PLURAL = ["", "понедельники", "вторники", "среды", "четверги", "пятницы", "субботы", "воскресенья"];
const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

export function weekdayShort(wd: number): string {
  return WEEKDAY_SHORT[wd] ?? "";
}

export function weekdayPlural(wd: number): string {
  return WEEKDAY_PLURAL[wd] ?? "";
}

export function fmtDate(day: number): string {
  const d = new Date(day * DAY_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function fmtDateTime(ms: number): string {
  const day = dayNumber(ms);
  return `${weekdayShort(weekdayOf(day))} ${fmtDate(day)} ${fmtHM(minuteOfDay(ms))}`;
}

export function isoDate(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}
