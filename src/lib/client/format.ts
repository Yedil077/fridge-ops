import type { FridgeStatus, RiskState } from "@/lib/domain/types";

export const STATUS_META: Record<FridgeStatus, { label: string; dot: string; text: string; ring: string }> = {
  normal: { label: "Normal", dot: "bg-good", text: "text-good-ink", ring: "border-line" },
  attention: { label: "Attention", dot: "bg-warn", text: "text-warn", ring: "border-warn/30" },
  critical: { label: "Critical", dot: "bg-crit", text: "text-crit-ink", ring: "border-crit/50" },
  closed: { label: "Closed", dot: "bg-ink-3", text: "text-ink-3", ring: "border-line" },
};

export const RISK_META: Record<RiskState, { label: string; cls: string }> = {
  EMPTY_RISK: { label: "Опустеет", cls: "text-crit-ink" },
  LOW_STOCK: { label: "Мало", cls: "text-warn" },
  NORMAL: { label: "Норма", cls: "text-ink-2" },
  OVERSTOCK: { label: "Избыток", cls: "text-accent" },
  WASTE_RISK: { label: "Риск списания", cls: "text-serious" },
  CLOSED: { label: "Закрыт", cls: "text-ink-3" },
};

export function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

const WD = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const MON = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

export function fmtDay(ms: number): string {
  const d = new Date(ms);
  return `${WD[d.getUTCDay()]}, ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

export function fmtMoney(v: number): string {
  return `${Math.round(v).toLocaleString("ru-RU")} ₽`;
}

export function pct(v: number, digits = 0): string {
  return `${(v * 100).toFixed(digits)}%`;
}

export function signed(v: number | null | undefined, suffix = "%"): string {
  if (v === null || v === undefined) return "—";
  return `${v > 0 ? "+" : ""}${v}${suffix}`;
}

export function r1(v: number): string {
  return (Math.round(v * 10) / 10).toLocaleString("ru-RU");
}
