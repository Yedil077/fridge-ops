"use client";

import clsx from "clsx";
import { Shell } from "@/components/Shell";
import { MissionCard } from "@/components/MissionCard";
import { FridgeCard } from "@/components/FridgeCard";
import { DevPanel } from "@/components/DevPanel";
import { useXpToasts } from "@/components/XpToast";
import { atLeast, useDashboard, useFlags, useMe, type DashboardView } from "@/lib/client/api";
import { ModeToggle } from "@/lib/client/forecastMode";
import { fmtClock, fmtMoney, pct, signed } from "@/lib/client/format";

export default function CommandCenter() {
  const { data, error, isLoading } = useDashboard();
  const toasts = useXpToasts();
  const { data: me } = useMe();

  if (error) {
    return (
      <Shell>
        <div className="card mx-auto mt-16 max-w-lg p-6 text-center">
          <div className="label mb-2">Нет данных</div>
          <p className="text-[14px] text-ink-2">{(error as Error).message}</p>
        </div>
      </Shell>
    );
  }
  if (isLoading || !data) {
    return (
      <Shell>
        <div className="mt-24 text-center text-[13px] text-ink-3">Загружаю 180 дней истории и считаю прогноз…</div>
      </Shell>
    );
  }

  return (
    <Shell now={data.now} mode={data.mode} player={data.player}>
      <TopStrip d={data} />

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <h2 className="label">Mission queue</h2>
            <ModeToggle size="sm" className="w-[220px]" />
            <span className="text-[11px] text-ink-3">
              {data.lastAnalysisAt ? `анализ в ${fmtClock(data.lastAnalysisAt)} · следующий через час` : ""}
            </span>
          </div>
          {data.missions.open.length === 0 ? (
            <div className="card flex items-center gap-4 p-6">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-good/15 text-good-ink">✓</span>
              <div>
                <div className="text-[15px] font-semibold">Всё сбалансировано</div>
                <div className="text-[13px] text-ink-3">Сейчас перемещения не нужны. Следующая проверка — через час.</div>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {data.missions.open.map((m) => (
                <MissionCard key={m.id} mission={m} onXp={toasts.push} />
              ))}
            </div>
          )}
        </section>

        <aside className="space-y-4">
          <ScoreCard d={data} />
          {data.missions.recent.length > 0 && (
            <div className="card p-4">
              <div className="label mb-3">Сегодня выполнено</div>
              <ul className="space-y-2">
                {data.missions.recent.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 text-[12px]">
                    <span className={m.status === "COMPLETED" ? "text-good-ink" : "text-ink-3"}>{m.status === "COMPLETED" ? "✓" : "–"}</span>
                    <span className="text-ink-2">
                      #{m.number} {m.sourceName} → {m.stops.map((s) => m.stopNames?.[s.targetFridgeId]).join(" → ")}
                    </span>
                    <span className="ml-auto text-ink-3">
                      {m.evaluation ? m.evaluation.result : m.status === "COMPLETED" ? "оценка через 2 ч" : "пропущена"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>

      <section className="mt-8">
        <div className="mb-3 flex items-baseline gap-3">
          <h2 className="label">Fridges</h2>
          <span className="text-[11px] text-ink-3">нажмите на карточку — профиль и прогноз точки</span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          {data.fridges.map((f) => (
            <FridgeCard key={f.id} f={f} />
          ))}
        </div>
      </section>

      {data.mode === "mock" && atLeast(me, "ADMIN") && <DevPanel />}
      {toasts.view}
    </Shell>
  );
}

function TopStrip({ d }: { d: DashboardView }) {
  const n = d.network;
  return (
    <section className="card grid grid-cols-2 gap-px overflow-hidden bg-line p-0 sm:grid-cols-3 lg:grid-cols-6">
      <Kpi label={d.greeting} value={`${n.fridgesOnline}/${n.fridgesTotal}`} sub="холодильников онлайн" />
      <Kpi label="Продажи сегодня" value={String(n.salesToday)} sub={n.vsTypicalPct === null ? "—" : `${signed(n.vsTypicalPct)} к обычному дню`} subTone={n.vsTypicalPct === null ? undefined : n.vsTypicalPct >= 0 ? "good" : "warn"} />
      <Kpi label="Выручка" value={fmtMoney(n.revenueToday)} />
      <Kpi label="Здоровье сети" value={pct(n.health)} tone={n.health >= 0.85 ? "good" : n.health >= 0.7 ? "warn" : "crit"} />
      <Kpi label="Critical / Attention" value={`${n.critical} / ${n.attention}`} tone={n.critical ? "crit" : undefined} />
      <Kpi label="Миссии" value={String(n.missionsOpen)} sub="в очереди" />
    </section>
  );
}

function Kpi({
  label,
  value,
  sub,
  tone,
  subTone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "warn" | "crit";
  subTone?: "good" | "warn";
}) {
  return (
    <div className="bg-surface px-4 py-3.5">
      <div className="label truncate">{label}</div>
      <div
        className={clsx(
          "num mt-1 text-[26px] font-semibold leading-none tracking-tight",
          tone === "good" && "text-good-ink",
          tone === "warn" && "text-warn",
          tone === "crit" && "text-crit-ink",
        )}
      >
        {value}
      </div>
      {sub && <div className={clsx("mt-1.5 text-[11px]", subTone === "good" ? "text-good-ink" : subTone === "warn" ? "text-warn" : "text-ink-3")}>{sub}</div>}
    </div>
  );
}

function ScoreCard({ d }: { d: DashboardView }) {
  const { rewards } = useFlags();
  const s = d.score;
  const rows = [
    { label: "Availability", value: pct(s.availability), good: s.availability >= 0.9 },
    { label: "Waste risk", value: pct(s.wasteRisk), good: s.wasteRisk <= 0.1 },
    { label: "Balance", value: pct(s.balance), good: s.balance >= 0.8 },
    { label: "Completed missions", value: String(s.completedMissions), good: true },
    { label: "Saved products", value: String(s.savedProducts), good: true },
  ];
  const tone = s.total >= 85 ? "text-good-ink" : s.total >= 70 ? "text-warn" : "text-crit-ink";
  return (
    <div className="card p-4">
      <div className="label">Daily score</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className={clsx("num text-[44px] font-semibold leading-none tracking-tight", tone)}>{s.total}</span>
        <span className="text-[14px] text-ink-3">/ 100</span>
      </div>
      <dl className="mt-4 space-y-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between text-[13px]">
            <dt className="text-ink-3">{r.label}</dt>
            <dd className={clsx("num font-medium", r.good ? "text-ink" : "text-warn")}>{r.value}</dd>
          </div>
        ))}
      </dl>
      {rewards && (
      <div className="mt-4 border-t border-line pt-3">
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-ink-2">
            Lv {d.player.level} · {d.player.title}
          </span>
          <span className="num text-xp">{d.player.xp} XP</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
          <div className="h-full rounded-full bg-xp transition-all" style={{ width: `${Math.round(d.player.progress * 100)}%` }} />
        </div>
        <div className="mt-1 text-right text-[10px] text-ink-3">до Lv {d.player.level + 1}: {d.player.levelTo - d.player.xp} XP</div>
      </div>
      )}
    </div>
  );
}
