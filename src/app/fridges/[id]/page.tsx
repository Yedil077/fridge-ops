"use client";

import Link from "next/link";
import { use } from "react";
import clsx from "clsx";
import { Shell } from "@/components/Shell";
import { MissionCard } from "@/components/MissionCard";
import { BarsChart, ChartCard, CHART, LinesChart } from "@/components/charts";
import { useFridge } from "@/lib/client/api";
import { RISK_META, STATUS_META, pct, r1, signed } from "@/lib/client/format";
import { CATEGORY_COLORS } from "@/lib/domain/categories";

const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function fmtMin(m: number | null) {
  if (m === null) return "хватит до закрытия";
  if (m === 0) return "пусто";
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60 ? `${m % 60} мин` : ""}`;
}

export default function FridgePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error } = useFridge(id);

  if (error) return <Shell><p className="mt-16 text-center text-ink-3">{(error as Error).message}</p></Shell>;
  if (!data) return <Shell><p className="mt-16 text-center text-[13px] text-ink-3">Загружаю профиль…</p></Shell>;

  const st = STATUS_META[data.status];
  const p = data.persona;
  const pacePct = Math.round((data.pace - 1) * 100);

  return (
    <Shell now={data.now}>
      <Link href="/" className="text-[12px] text-ink-3 hover:text-ink">← Command Center</Link>

      <header className="mt-3 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div>
          <div className="text-[28px] font-semibold tracking-tight">{data.fridge.name}</div>
          <div className="text-[13px] text-ink-3">
            {data.fridge.location} · {data.fridge.workingDays.map((d) => WD[d - 1]).join(" ")} · {data.fridge.opening}–{data.fridge.closing}
          </div>
        </div>
        <div className={clsx("flex items-center gap-2 text-[13px] font-medium", st.text)}>
          <span className={clsx("h-2.5 w-2.5 rounded-full", st.dot)} /> {st.label}
        </div>
        <div className="rounded-xl border border-line-strong bg-surface-2 px-4 py-2">
          <div className="label">Profile</div>
          <div className="text-[16px] font-semibold">
            {p.emoji} {p.title}
          </div>
        </div>
      </header>

      <div className="mt-4 flex flex-wrap gap-2">
        {p.traits.map((t) => (
          <span key={t.label + t.value} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[12px]">
            <span className="text-ink-2">{t.label}</span>{" "}
            <span className={clsx("num", t.tone === "up" ? "text-good-ink" : t.tone === "down" ? "text-serious" : "text-ink")}>{t.value}</span>
          </span>
        ))}
      </div>

      <section className="card mt-5 grid grid-cols-2 gap-px overflow-hidden bg-line p-0 md:grid-cols-5">
        <Stat label="Продажи сегодня" value={String(data.salesToday)} />
        <Stat label="Обычный такой день" value={String(data.typicalDayTotal)} />
        <Stat label="Прогноз на день" value={String(data.projectedDayTotal)} />
        <Stat label="Темп дня" value={signed(pacePct)} tone={pacePct >= 5 ? "good" : pacePct <= -10 ? "warn" : undefined} />
        <Stat label="Уверенность" value={pct(data.confidence)} />
      </section>
      {data.anomaly && (
        <div className="mt-3 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-[13px] text-warn">
          ⚡ ANOMALY — сегодняшний спрос {signed(data.anomaly.deviationPct)} к историческому диапазону. Прогноз на сегодня повышен, долгосрочный профиль не меняется.
        </div>
      )}

      <section className="card mt-5 overflow-x-auto p-0">
        <table className="w-full min-w-[860px] text-[13px]">
          <thead>
            <tr className="border-b border-line text-left">
              {["Категория", "Остаток", "Статус", "Скорость", "Прогноз 2 ч", "До закрытия", "Закончится", "Уверенность", "Основа прогноза"].map((h) => (
                <th key={h} className="label px-4 py-3 font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.categories.map((c) => (
              <tr key={c.id} className="border-b border-line last:border-0">
                <td className="px-4 py-3">{c.emoji} {c.name}</td>
                <td className="num px-4 py-3 text-[15px] font-semibold">{c.stock}</td>
                <td className={clsx("px-4 py-3", RISK_META[c.state].cls)}>{RISK_META[c.state].label}</td>
                <td className="num px-4 py-3 text-ink-2">{r1(c.velocity)}/ч</td>
                <td className="num px-4 py-3 text-ink-2">{c.interval2h[0]}–{c.interval2h[1]}</td>
                <td className="num px-4 py-3 text-ink-2">{c.intervalClose[0]}–{c.intervalClose[1]}</td>
                <td className={clsx("px-4 py-3", c.minutesToEmpty !== null && c.minutesToEmpty <= 90 ? "text-crit-ink" : "text-ink-2")}>{fmtMin(c.minutesToEmpty)}</td>
                <td className="num px-4 py-3 text-ink-2">{pct(c.confidence)}</td>
                <td className="px-4 py-3 text-[12px] text-ink-3">
                  {c.baseline.label}
                  {Math.abs(c.bias - 1) > 0.02 && <span className="ml-1 text-accent">· коррекция {signed(Math.round((c.bias - 1) * 100))}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <ChartCard title="Hourly pattern" subtitle="Сегодня vs обычный такой же день недели (история, взвешенная по давности)">
          <LinesChart
            data={data.hourly}
            x="label"
            series={[
              { key: "today", name: "Сегодня", color: CHART.series1 },
              { key: "typical", name: "Обычно", color: CHART.reference, dashed: true },
              { key: "forecast", name: "Прогноз", color: CHART.series2, dashed: true },
            ]}
          />
        </ChartCard>
        <ChartCard title="Day-of-week" subtitle="Средние продажи за день, последние 90 дней (0 — закрыт)">
          <BarsChart data={p.weekdayAvg.map((v, i) => ({ name: WD[i], avg: Math.round(v) }))} x="name" series={[{ key: "avg", name: "Продажи/день", color: CHART.series1 }]} />
        </ChartCard>
        <ChartCard title="Demand index" subtitle="1.00 = средняя доля категории по сети">
          <div className="space-y-2">
            {data.categories.map((c, i) => {
              const v = p.demandIndex[i];
              return (
                <div key={c.id} className="flex items-center gap-3 text-[12px]">
                  <span className="w-28 text-ink-2">{c.emoji} {c.name}</span>
                  <div className="relative h-2 flex-1 rounded-full bg-surface-3">
                    <div className="absolute top-[-3px] h-[14px] w-px bg-ink-3" style={{ left: "50%" }} />
                    <div className="h-full rounded-full" style={{ width: `${Math.min(100, (v / 2) * 100)}%`, background: CATEGORY_COLORS[c.id] }} />
                  </div>
                  <span className={clsx("num w-12 text-right", v >= 1.25 ? "text-good-ink" : v <= 0.8 ? "text-serious" : "text-ink")}>{v.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
        </ChartCard>
        <ChartCard title="Trend detection" subtitle="Продаж в день: 6 мес назад → 3 мес → последние 30 дней">
          <table className="w-full text-[12px]">
            <tbody>
              {p.trend.map((t) => (
                <tr key={t.categoryIndex} className="border-b border-line last:border-0">
                  <td className="py-1.5 text-ink-2">{data.categories[t.categoryIndex].emoji} {data.categories[t.categoryIndex].name}</td>
                  <td className="num py-1.5 text-right text-ink-3">{r1(t.sixMonthsAgo)}</td>
                  <td className="num py-1.5 text-right text-ink-3">{r1(t.threeMonthsAgo)}</td>
                  <td className="num py-1.5 text-right text-ink">{r1(t.last30)}</td>
                  <td className={clsx("num py-1.5 text-right", t.changePct >= 20 ? "text-good-ink" : t.changePct <= -20 ? "text-serious" : "text-ink-3")}>
                    {t.sixMonthsAgo > 0 ? signed(t.changePct) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ChartCard>
        <ChartCard title="Products" subtitle="Последние 30 дней, штук в рабочий день">
          <div className="grid grid-cols-2 gap-4 text-[12px]">
            <div>
              <div className="mb-2 text-good-ink">Лидеры</div>
              {p.topProducts.map((x, i) => (
                <div key={x.name} className="flex justify-between py-1"><span className="text-ink-2">{i + 1}. {x.name}</span><span className="num">{r1(x.perDay)}</span></div>
              ))}
            </div>
            <div>
              <div className="mb-2 text-serious">Слабые</div>
              {p.weakProducts.map((x, i) => (
                <div key={x.name} className="flex justify-between py-1"><span className="text-ink-2">{i + 1}. {x.name}</span><span className="num">{r1(x.perDay)}</span></div>
              ))}
            </div>
          </div>
        </ChartCard>
        <ChartCard title="Missions" subtitle="Перемещения с участием точки">
          {data.missions.length === 0 ? (
            <p className="text-[12px] text-ink-3">Пока не было.</p>
          ) : (
            <div className="space-y-3">{data.missions.slice(0, 3).map((m) => <MissionCard key={m.id} mission={m} compact />)}</div>
          )}
        </ChartCard>
      </div>
    </Shell>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" }) {
  return (
    <div className="bg-surface px-4 py-3.5">
      <div className="label">{label}</div>
      <div className={clsx("num mt-1 text-[24px] font-semibold leading-none", tone === "good" && "text-good-ink", tone === "warn" && "text-warn")}>{value}</div>
    </div>
  );
}
