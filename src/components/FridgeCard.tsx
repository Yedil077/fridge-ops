"use client";

import Link from "next/link";
import clsx from "clsx";
import type { DashboardView } from "@/lib/client/api";
import { RISK_META, STATUS_META, signed } from "@/lib/client/format";

type FridgeCardData = DashboardView["fridges"][number];

export function FridgeCard({ f }: { f: FridgeCardData }) {
  const st = STATUS_META[f.status];
  const fillColor = f.fillPct < 25 ? "bg-crit" : f.fillPct < 45 ? "bg-warn" : "bg-ink-2";
  return (
    <Link
      href={`/fridges/${f.id}`}
      className={clsx("card group block p-4 transition hover:border-line-strong hover:bg-surface-2", st.ring, !f.isOpenNow && "opacity-60")}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[15px] font-semibold">{f.name}</div>
          <div className="mt-0.5 line-clamp-1 text-[11px] text-ink-3">{f.location}</div>
        </div>
        <div className={clsx("flex items-center gap-1.5 text-[11px] font-medium", st.text)}>
          <span className={clsx("h-2 w-2 rounded-full", st.dot, f.status === "critical" && "pulse")} />
          {st.label}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
          <div className={clsx("h-full rounded-full transition-all", fillColor)} style={{ width: `${f.fillPct}%` }} />
        </div>
        <span className="num w-9 text-right text-[12px] text-ink-2">{f.fillPct}%</span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-x-2 gap-y-1.5">
        {f.categories.map((c) => (
          <div key={c.id} className="flex items-center gap-1 text-[12px]" title={`${c.name}: ${RISK_META[c.state].label}`}>
            <span>{c.emoji}</span>
            <span className={clsx("num font-medium", c.state === "NORMAL" || c.state === "CLOSED" ? "text-ink" : RISK_META[c.state].cls)}>{c.stock}</span>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-end justify-between border-t border-line pt-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-ink-3">Продажи</div>
          <div className="num text-[18px] font-semibold leading-tight">{f.salesToday}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-ink-3">К норме</div>
          <div
            className={clsx(
              "num text-[13px] font-medium",
              f.trendPct === null ? "text-ink-3" : f.trendPct >= 5 ? "text-good-ink" : f.trendPct <= -10 ? "text-serious" : "text-ink-2",
            )}
          >
            {f.trendPct === null ? "—" : `${f.trendPct >= 0 ? "↑" : "↓"} ${signed(f.trendPct)}`}
          </div>
        </div>
      </div>

      <div className="mt-2 min-h-[18px] text-[11px] leading-snug">
        {!f.isOpenNow ? (
          <span className="text-ink-3">{f.opensAt ? `Обычно продажи с ${f.opensAt}` : "Сейчас продаж обычно нет"}</span>
        ) : f.anomaly ? (
          <span className="text-warn">⚡ ANOMALY · спрос {signed(f.anomaly.deviationPct)} к норме</span>
        ) : f.forecastNote ? (
          <span className={f.status === "critical" ? "text-crit-ink" : "text-ink-2"}>{f.forecastNote}</span>
        ) : (
          <span className="text-ink-3">
            {f.profile.emoji} {f.profile.title}
          </span>
        )}
      </div>
    </Link>
  );
}
