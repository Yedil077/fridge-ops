"use client";

import clsx from "clsx";
import type { ProfilesView } from "@/lib/client/api";

type Profile = ProfilesView["profiles"][number];

const STATUS: Record<Profile["today"]["status"], { text: string; cls: string }> = {
  NORMAL: { text: "НОРМА", cls: "bg-good/15 text-good-ink" },
  ABOVE: { text: "ВЫШЕ НОРМЫ", cls: "bg-accent/15 text-accent" },
  BELOW: { text: "НИЖЕ НОРМЫ", cls: "bg-warn/20 text-warn" },
  ANOMALY: { text: "АНОМАЛИЯ", cls: "bg-crit/20 text-crit-ink" },
  QUIET: { text: "СЕЙЧАС ТИХО", cls: "bg-surface-3 text-ink-3" },
  NO_DATA: { text: "МАЛО ДАННЫХ", cls: "bg-surface-3 text-ink-3" },
};

const DEMAND = { HIGH: "высокий", NORMAL: "обычный", LOW: "низкий" } as const;

export function StatusBadge({ p }: { p: Profile }) {
  const st = STATUS[p.today.status];
  const pct = p.today.deviationPct;
  return (
    <span className={clsx("whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-bold tracking-wide", st.cls)}>
      {st.text}
      {pct !== null && p.today.status !== "QUIET" && p.today.status !== "NO_DATA" ? ` ${pct > 0 ? "+" : ""}${pct}%` : ""}
    </span>
  );
}

/** One fridge: conclusions first (norm, today, need / can give), then the character behind them. */
export function FridgeProfileCard({ p, compact }: { p: Profile; compact?: boolean }) {
  return (
    <section className="card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[16px] font-bold">{p.name}</div>
          <div className="text-[12px] text-ink-3">{p.today.label}</div>
        </div>
        <StatusBadge p={p} />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-[12px]">
        <Fact label="Норма в день" value={`${p.normalDay.low}–${p.normalDay.high}`} sub={`в среднем ${p.normalDay.avg}`} />
        <Fact label="Сегодня" value={String(p.today.sales)} sub={`к этому часу обычно ${p.normalByNow.low}–${p.normalByNow.high}`} />
        <Fact label="Остаток" value={String(p.stock)} sub="блюд" />
      </div>

      {p.summary.length > 0 && (
        <ul className="mt-3 space-y-1 text-[13px]">
          {p.summary.map((s) => (
            <li key={s} className={clsx(s.startsWith("Нужно") ? "text-crit-ink" : s.startsWith("Может отдать") ? "text-good-ink" : "text-ink")}>
              {s}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {p.tags.map((t) => (
          <span key={t.label} className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold text-ink-2">
            {t.emoji} {t.label}
          </span>
        ))}
      </div>

      {!compact && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] text-ink-2">
            <div>Пик: <b className="text-ink">{p.peaks.join(", ") || "—"}</b></div>
            <div>Сильный день: <b className="text-ink">{p.strongWeekdays.join(", ") || "ровно"}</b></div>
            <div>Сильнее сети: <b className="text-ink">{p.strongest ? `${p.strongest.emoji} ${p.strongest.name} ${p.strongest.vsNetworkPct > 0 ? "+" : ""}${p.strongest.vsNetworkPct}%` : "—"}</b></div>
            <div>Слабее сети: <b className="text-ink">{p.weakest ? `${p.weakest.emoji} ${p.weakest.name} ${p.weakest.vsNetworkPct > 0 ? "+" : ""}${p.weakest.vsNetworkPct}%` : "—"}</b></div>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[420px] text-[12px] [&_td]:px-1.5 [&_th]:px-1.5">
              <thead className="text-left text-ink-3">
                <tr>
                  <th className="py-1">Категория</th>
                  <th className="text-right">Спрос к сети</th>
                  <th className="text-right">Есть</th>
                  <th className="text-right" title="ближайшие ~1,5 часа">Сейчас</th>
                  <th className="text-right">До вечера</th>
                  <th>Вывод</th>
                </tr>
              </thead>
              <tbody>
                {p.categories.map((c) => (
                  <tr key={c.id} className="border-t border-line">
                    <td className="py-1">
                      {c.emoji} {c.name}
                    </td>
                    <td className={clsx("num text-right", c.demand === "HIGH" ? "text-good-ink" : c.demand === "LOW" ? "text-ink-3" : "")} title={`спрос ${DEMAND[c.demand]}`}>
                      {c.index.toFixed(2)}×
                    </td>
                    <td className="num text-right">{c.stock}</td>
                    <td className="num text-right">{c.expectedNow}</td>
                    <td className="num text-right">{c.untilEvening}</td>
                    <td className={clsx("whitespace-nowrap", c.status === "LOW" ? "text-crit-ink" : c.status === "SURPLUS" ? "text-good-ink" : "text-ink-3")}>
                      {c.status === "LOW" ? `нужно +${c.need}` : c.status === "SURPLUS" ? `может отдать ${c.canGive}` : "норма"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {p.topProducts.length > 0 && (
            <div className="mt-3 text-[12px]">
              <div className="label mb-1">Любимые блюда (за 30 дней)</div>
              {p.topProducts.slice(0, 3).map((t, i) => (
                <div key={t.name} className="flex justify-between gap-2">
                  <span className="truncate">
                    {i + 1}. {t.name}
                  </span>
                  <span className="num shrink-0 text-ink-3">
                    {t.perDay}/день · {t.affinity.toFixed(2)}×
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 flex gap-1 text-center text-[11px]">
            {p.weekdayIndex.map((w) => (
              <div key={w.day} className={clsx("flex-1 rounded py-1", w.index >= 1.12 ? "bg-good/15 text-good-ink" : w.index === 0 ? "bg-surface-2 text-ink-3" : w.index <= 0.85 ? "bg-warn/15 text-warn" : "bg-surface-2")}>
                <div>{w.day}</div>
                <div className="num font-semibold">{w.index ? w.index.toFixed(2) : "—"}</div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="mt-2 text-[11px] text-ink-3">
        Уверенность профиля {Math.round(p.confidence * 100)}% · истории {p.dataDays} дн.
        {p.confidence < 0.6 ? " — рекомендации осторожнее" : ""}
      </div>
    </section>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-surface-2 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-ink-3">{label}</div>
      <div className="num text-[17px] font-bold leading-tight">{value}</div>
      {sub && <div className="text-[10px] leading-tight text-ink-3">{sub}</div>}
    </div>
  );
}
