"use client";

import Link from "next/link";
import clsx from "clsx";
import type { MobileRoute } from "@/lib/client/mobileApi";

export const URGENCY: Record<MobileRoute["urgency"], { label: string; dot: string; cls: string; border: string }> = {
  NOW: { label: "СРОЧНО", dot: "🔴", cls: "bg-crit/15 text-crit-ink", border: "border-crit/50" },
  TODAY: { label: "СЕГОДНЯ", dot: "🟡", cls: "bg-warn/15 text-warn", border: "border-warn/30" },
  LATER: { label: "МОЖНО ПОЗЖЕ", dot: "🟢", cls: "bg-good/15 text-good-ink", border: "border-line" },
};

export function UrgencyPill({ u, big }: { u: MobileRoute["urgency"]; big?: boolean }) {
  const m = URGENCY[u];
  return (
    <span className={clsx("inline-flex items-center gap-1.5 rounded-lg font-bold tracking-wider", m.cls, big ? "px-3 py-1.5 text-[14px]" : "px-2 py-1 text-[11px]")}>
      {m.dot} {m.label}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("animate-pulse rounded-2xl bg-surface-2", className)} />;
}

export function SkeletonList() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-24" />
      <Skeleton className="h-44" />
      <Skeleton className="h-20" />
      <Skeleton className="h-20" />
    </div>
  );
}

export function routeTargets(r: MobileRoute): string {
  return r.stops.map((s) => s.name).join(" → ");
}

/** Compact route card used in lists. */
export function RouteRow({ r }: { r: MobileRoute }) {
  const mine = r.status === "IN_PROGRESS" || r.status === "ACCEPTED";
  return (
    <Link href={`/m/tasks/${r.id}`} className={clsx("card flex min-h-[64px] items-center gap-3 px-4 py-3 active:bg-surface-2", mine && "border-accent/50")}>
      <span className="text-[18px]">{URGENCY[r.urgency].dot}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[16px] font-semibold">
          {r.sourceName} → {routeTargets(r)}
        </div>
        <div className="text-[13px] text-ink-3">
          {r.totalItems} {plural(r.totalItems, "позиция", "позиции", "позиций")}
          {r.stops.length > 1 ? ` · ${r.stops.length} точки` : ""}
          {mine ? ` · в работе${r.acceptedBy ? ` (${r.acceptedBy})` : ""}` : ""}
        </div>
      </div>
      <span className="text-[22px] text-ink-3">›</span>
    </Link>
  );
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** One dish, designed against picking the wrong item: big name, category color, SKU, quantity. */
export function DishRow({
  name,
  sku,
  emoji,
  color,
  categoryName,
  qty,
  checked,
  onToggle,
  hint,
  strike,
}: {
  name: string;
  sku: string;
  emoji: string;
  color: string;
  categoryName: string;
  qty: number;
  checked?: boolean;
  onToggle?: () => void;
  hint?: string | null;
  strike?: boolean;
}) {
  const body = (
    <>
      <span className="w-1.5 self-stretch rounded-full" style={{ background: color }} aria-hidden />
      <div className="min-w-0 flex-1 py-1">
        <div className={clsx("text-[18px] font-semibold leading-snug", strike && "text-ink-3 line-through")}>{name}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
          <span>
            {emoji} {categoryName}
          </span>
          <span className="rounded bg-surface-3 px-1.5 py-px font-mono text-[12px] text-ink-2">{sku}</span>
        </div>
        {hint && <div className="mt-1 text-[12px] text-ink-3">{hint}</div>}
      </div>
      <div className="num shrink-0 text-right text-[28px] font-bold leading-none">×{qty}</div>
      {onToggle && (
        <span
          className={clsx(
            "grid h-11 w-11 shrink-0 place-items-center rounded-xl border-2 text-[22px] font-bold transition",
            checked ? "border-good bg-good text-white" : "border-line-strong text-transparent",
          )}
          aria-hidden
        >
          ✓
        </span>
      )}
    </>
  );
  if (!onToggle) return <div className="flex items-center gap-3 rounded-2xl bg-surface px-3 py-3">{body}</div>;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={!!checked}
      onClick={onToggle}
      className={clsx("flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition active:scale-[0.99]", checked ? "border-good/50 bg-good/10" : "border-line bg-surface")}
    >
      {body}
    </button>
  );
}
