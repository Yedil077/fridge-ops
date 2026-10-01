"use client";

import clsx from "clsx";

/**
 * Observed activity of a fridge — learned from real sale timestamps (00:00–23:59, every weekday).
 * The configured schedule is shown next to it; differences are SCHEDULE MISMATCH, the sales are kept.
 */

export interface ActivityData {
  configured: string;
  ranges: string[];
  learnedWeekdays: number;
  nightShare: number;
  weekendShare: number;
  peaks: string[];
  topHours: string[];
  mismatches: { weekday: string; hours: string }[];
  heatmap: number[][];
}

const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export function ActivityPanel({ a, title = "Фактическая активность" }: { a: ActivityData; title?: string }) {
  return (
    <section className="card p-4">
      <div className="label mb-3">{title}</div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Ночные продажи (22:00–06:00)" value={`${a.nightShare}%`} />
        <Stat label="Продажи в выходные" value={`${a.weekendShare}%`} />
        <Stat label="Пиковые часы" value={a.peaks.join(", ") || "—"} />
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <div className="text-[12px] text-ink-3">Observed active hours (по продажам, 90 дней)</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {a.ranges.length ? (
              a.ranges.map((r) => (
                <span key={r} className="rounded-md bg-surface-2 px-2 py-1 font-mono text-[12px]">
                  {r}
                </span>
              ))
            ) : (
              <span className="text-[13px] text-ink-3">продаж в истории нет</span>
            )}
          </div>
          {a.learnedWeekdays < 7 && <div className="mt-1 text-[11px] text-ink-3">Для {7 - a.learnedWeekdays} дн. недели мало истории — используется график из Настроек.</div>}
        </div>
        <div>
          <div className="text-[12px] text-ink-3">График в Настройках (подсказка, не фильтр)</div>
          <div className="mt-1 text-[13px]">{a.configured}</div>
          {a.mismatches.length > 0 && (
            <div className="mt-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12px]">
              <div className="font-semibold text-warn">SCHEDULE MISMATCH — по графику закрыто, но продажи есть</div>
              {a.mismatches.map((m) => (
                <div key={m.weekday} className="mt-0.5">
                  <span className="text-ink-2">{m.weekday}:</span> {m.hours}
                </div>
              ))}
              <div className="mt-1 text-ink-3">Эти продажи учитываются в прогнозе и аналитике.</div>
            </div>
          )}
        </div>
      </div>
      <div className="mt-4">
        <div className="mb-1 text-[12px] text-ink-3">День недели × час (среднее продаж в день)</div>
        <WeekHourHeatmap data={a.heatmap} />
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className="num mt-0.5 text-[16px] font-semibold">{value}</div>
    </div>
  );
}

/** 7 × 24 heatmap, hours 00–23 — night, morning, weekend and peak sales are all visible. */
export function WeekHourHeatmap({ data, weekdays = WD }: { data: number[][]; weekdays?: string[] }) {
  const max = Math.max(0.01, ...data.flat());
  return (
    <div className="overflow-x-auto">
      <table className="border-separate border-spacing-[2px] text-[10px]">
        <thead>
          <tr>
            <th />
            {Array.from({ length: 24 }, (_, h) => (
              <th key={h} className={clsx("w-6 text-center font-normal text-ink-3", (h >= 22 || h < 6) && "text-accent")}>
                {String(h).padStart(2, "0")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, w) => (
            <tr key={w}>
              <td className={clsx("pr-1.5 text-[11px]", w >= 5 ? "text-accent" : "text-ink-3")}>{weekdays[w]}</td>
              {row.map((v, h) => (
                <td
                  key={h}
                  title={`${weekdays[w]} ${String(h).padStart(2, "0")}:00 — ${v} шт./день`}
                  className="h-5 w-6 rounded-[3px]"
                  style={{ background: v > 0 ? `rgba(110,168,255,${0.12 + 0.88 * Math.sqrt(v / max)})` : "var(--color-surface-2)" }}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
