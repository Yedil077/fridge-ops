"use client";

import { useState } from "react";
import clsx from "clsx";
import { Shell } from "@/components/Shell";
import { BarsChart, ChartCard, CHART, LinesChart } from "@/components/charts";
import { HistoryExplorer } from "@/components/HistoryExplorer";
import { useAnalytics, type AnalyticsView } from "@/lib/client/api";
import { fmtClock, pct, signed } from "@/lib/client/format";
import { categoryById } from "@/lib/domain/categories";
import { ActivityPanel, WeekHourHeatmap } from "@/components/ActivityPanel";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "time", label: "Время" },
  { id: "heatmap", label: "Heatmap" },
  { id: "missions", label: "Missions" },
  { id: "history", label: "History" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export default function AnalyticsPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const { data, error } = useAnalytics();
  return (
    <Shell now={data?.now}>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <h1 className="mr-4 text-[20px] font-semibold tracking-tight">Analytics</h1>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={clsx("rounded-md px-3 py-1.5 text-[13px]", tab === t.id ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink")}
          >
            {t.label}
          </button>
        ))}
      </div>
      {error && <p className="text-crit-ink">{(error as Error).message}</p>}
      {tab === "history" ? <HistoryExplorer /> : !data ? <p className="text-[13px] text-ink-3">Считаю…</p> : tab === "overview" ? <Overview d={data} /> : tab === "time" ? <TimeTab d={data} /> : tab === "heatmap" ? <Heatmap d={data} /> : <Missions d={data} />}
    </Shell>
  );
}

function Overview({ d }: { d: AnalyticsView }) {
  const diff = d.typicalSoFar > 0 ? Math.round((d.salesSoFar / d.typicalSoFar - 1) * 100) : null;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartCard
        title="Hourly demand · network"
        subtitle={
          <>
            Сегодня <span className="num text-ink">{d.salesSoFar}</span> продаж · обычно к этому часу{" "}
            <span className="num text-ink">{d.typicalSoFar}</span> ({d.weekdayName}) ·{" "}
            <span className={diff !== null && diff >= 0 ? "text-good-ink" : "text-warn"}>{signed(diff)}</span> — прогноз скорректирован автоматически
          </>
        }
        className="lg:col-span-2"
      >
        <LinesChart
          data={d.hourly}
          x="label"
          series={[
            { key: "today", name: "Сегодня", color: CHART.series1 },
            { key: "typical", name: `Обычные ${d.weekdayName}`, color: CHART.reference, dashed: true },
          ]}
          height={260}
        />
      </ChartCard>
      <ChartCard title="Sales by fridge" subtitle="Сегодня vs обычно к этому часу">
        <BarsChart
          data={d.byFridge}
          denseX
          x="name"
          series={[
            { key: "today", name: "Сегодня", color: CHART.series1 },
            { key: "typicalSoFar", name: "Обычно к этому часу", color: CHART.series2 },
          ]}
          height={260}
        />
      </ChartCard>
      <ChartCard title="Sales by category" subtitle="Сегодня · в среднем за день (30 дней)">
        <BarsChart
          data={d.byCategory.map((c) => ({ ...c, name: `${c.emoji} ${c.name}` }))}
          x="name"
          series={[
            { key: "today", name: "Сегодня", color: CHART.series1 },
            { key: "avgPerDay30", name: "В среднем/день", color: CHART.series2 },
          ]}
          height={260}
        />
      </ChartCard>
      <ChartCard title="Day-of-week demand" subtitle="Вся сеть, средние продажи за день (90 дней)">
        <BarsChart data={d.weekday} x="name" series={[{ key: "avg", name: "Продажи/день", color: CHART.series1 }]} />
      </ChartCard>
      <ChartCard title="Waste risk" subtitle="Ожидаемое списание к концу активности точки, шт.">
        <BarsChart data={d.wasteRisk.slice(0, 10)} x="name" series={[{ key: "units", name: "Риск списания, шт.", color: CHART.series2 }]} layout="vertical" height={260} />
      </ChartCard>
    </div>
  );
}

/** Sales by hour 0–23 and weekday × hour: every real sale counts — night, morning, weekend. */
function TimeTab({ d }: { d: AnalyticsView }) {
  const t = d.time;
  const [pick, setPick] = useState<string>(t.fridges[0]?.id ?? "");
  const chosen = t.fridges.find((f) => f.id === pick);
  return (
    <div className="grid gap-4">
      <ChartCard
        title="SALES BY HOUR · 00–23"
        subtitle={`Вся сеть, среднее продаж в час за день (90 дней, все дни недели). Ночные продажи 22:00–06:00: ${t.nightShare}% · выходные: ${t.weekendShare}%`}
      >
        <BarsChart data={t.salesByHour} x="label" series={[{ key: "avg", name: "Продажи/день", color: CHART.series1 }]} height={240} />
      </ChartCard>
      <ChartCard title="Heatmap · день недели × час" subtitle="Вся сеть, среднее продаж в день. Синим выделены ночь и выходные.">
        <WeekHourHeatmap data={t.weekHour} weekdays={t.weekdays} />
      </ChartCard>
      <ChartCard title="Точки: активность по реальным продажам" subtitle="Peak hours, доля ночных и выходных продаж, фактические часы активности и расхождения с графиком">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[12px]">
            <thead>
              <tr className="text-left text-ink-3">
                <th className="py-1.5 pr-3 font-normal">Точка</th>
                <th className="pr-3 font-normal">Peak hours</th>
                <th className="pr-3 font-normal">Ночь</th>
                <th className="pr-3 font-normal">Выходные</th>
                <th className="pr-3 font-normal">Активна (пример)</th>
                <th className="font-normal">График</th>
              </tr>
            </thead>
            <tbody>
              {t.fridges.map((f) => (
                <tr key={f.id} onClick={() => setPick(f.id)} className={clsx("cursor-pointer border-t border-line", pick === f.id && "bg-surface-2")}>
                  <td className="py-1.5 pr-3">{f.name}</td>
                  <td className="pr-3">{f.peaks.join(", ") || "—"}</td>
                  <td className="num pr-3">{f.nightShare}%</td>
                  <td className="num pr-3">{f.weekendShare}%</td>
                  <td className="pr-3 font-mono text-[11px]">{f.ranges.slice(0, 2).join(" · ")}{f.ranges.length > 2 ? " …" : ""}</td>
                  <td>{f.mismatches.length ? <span className="text-warn">SCHEDULE MISMATCH</span> : <span className="text-ink-3">совпадает</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>
      {chosen && <ActivityPanel a={chosen} title={`${chosen.name} · фактическая активность`} />}
    </div>
  );
}

/** Diverging color for a demand index: blue (low) ← gray (1.0) → red (high), log scale 0.5×…2×. */
function indexColor(v: number): string {
  const t = Math.max(-1, Math.min(1, Math.log2(Math.max(0.01, v))));
  const mid = [56, 56, 53];
  const pole = t >= 0 ? [230, 103, 103] : [57, 135, 229];
  const k = Math.abs(t);
  const c = mid.map((m, i) => Math.round(m + (pole[i] - m) * k));
  return `rgb(${c.join(",")})`;
}

function flames(v: number): string {
  if (v >= 1.6) return "🔥🔥🔥";
  if (v >= 1.25) return "🔥🔥";
  if (v >= 1.05) return "🔥";
  if (v <= 0.8) return "❄️";
  return "·";
}

function Heatmap({ d }: { d: AnalyticsView }) {
  const [hover, setHover] = useState<string | null>(null);
  return (
    <ChartCard title="Fridge × Category" subtitle="Demand index: доля категории в точке ÷ доля по сети. 1.00 — как в среднем, 2.00 — вдвое чаще. История 180 дней, свежие данные весят больше.">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-separate border-spacing-[2px] text-[12px]">
          <thead>
            <tr>
              <th />
              {d.categories.map((c) => (
                <th key={c.id} className="label px-2 pb-2 text-center font-semibold">
                  {c.emoji} {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.heatmap.map((row) => (
              <tr key={row.id}>
                <td className="whitespace-nowrap pr-3 font-mono text-[12px] text-ink-2">{row.name}</td>
                {row.index.map((v, c) => {
                  const key = `${row.id}:${c}`;
                  return (
                    <td
                      key={c}
                      onMouseEnter={() => setHover(key)}
                      onMouseLeave={() => setHover(null)}
                      className="relative h-11 rounded-md text-center"
                      style={{ background: indexColor(v) }}
                    >
                      <div className="num text-[13px] font-semibold text-white">{v.toFixed(2)}</div>
                      <div className="text-[10px] leading-none">{flames(v)}</div>
                      {hover === key && (
                        <div className="absolute left-1/2 top-full z-10 mt-1 w-44 -translate-x-1/2 rounded-lg border border-line-strong bg-surface-2 p-2 text-left text-[11px] shadow-xl">
                          <div className="text-ink">{row.name} · {d.categories[c].name}</div>
                          <div className="text-ink-3">Доля в точке: <span className="num text-ink">{row.share[c]}%</span></div>
                          <div className="text-ink-3">Индекс: <span className="num text-ink">{v.toFixed(2)}×</span></div>
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex items-center gap-3 text-[11px] text-ink-3">
        <span>0.5× ниже сети</span>
        <div className="h-2 w-48 rounded-full" style={{ background: `linear-gradient(90deg, ${indexColor(0.5)}, ${indexColor(1)}, ${indexColor(2)})` }} />
        <span>2× выше сети</span>
      </div>
    </ChartCard>
  );
}

function Missions({ d }: { d: AnalyticsView }) {
  const m = d.missions;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="card p-4 lg:col-span-3">
        <div className="label mb-2">Recommendation acceptance</div>
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
          <div>
            <span className="num text-[28px] font-semibold">{d.acceptance.ratio === null ? "—" : pct(d.acceptance.ratio)}</span>
            <span className="ml-2 text-[13px] text-ink-3">
              перенесено {d.acceptance.moved} из {d.acceptance.recommended} рекомендованных
            </span>
          </div>
          {Object.keys(d.acceptance.skipReasons).length > 0 && (
            <div className="text-[12px] text-ink-3">
              Пропуски:{" "}
              {Object.entries(d.acceptance.skipReasons).map(([k, v]) => (
                <span key={k} className="mr-3">
                  {({ no_stock: "нет в наличии", not_needed: "не хочу переносить", low_left: "мало осталось", other: "другое", skipped: "без причины" } as Record<string, string>)[k] ?? k}: {v}
                </span>
              ))}
            </div>
          )}
        </div>
        {d.acceptance.bySource.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2 text-[12px]">
            {d.acceptance.bySource.map((s) => (
              <span key={s.name} className={clsx("rounded-lg border px-2 py-1", s.ratio < 0.6 ? "border-warn/40 text-warn" : "border-line text-ink-2")}>
                {s.name}: {pct(s.ratio)} <span className="text-ink-3">({s.n})</span>
              </span>
            ))}
          </div>
        )}
        <p className="mt-2 text-[12px] text-ink-3">Если по точке берут стабильно меньше рекомендованного, система сама уменьшает объёмы для неё.</p>
      </div>
      <div className="card grid grid-cols-2 gap-4 p-4 lg:col-span-3 lg:grid-cols-5">
        <Metric label="Выполнено" value={String(m.byStatus.COMPLETED)} />
        <Metric label="Оценено" value={String(m.evaluated)} />
        <Metric label="Перенесено / продано" value={`${m.moved} / ${m.sold}`} />
        <Metric label="Mission effectiveness" value={m.successRate === null ? "—" : pct(m.successRate)} />
        <Metric label="Prediction accuracy" value={m.accuracy === null ? "—" : pct(m.accuracy)} />
      </div>
      <ChartCard title="Результаты" subtitle="Доля перенесённого, проданного за 2 часа">
        <BarsChart
          data={[
            { name: "Excellent", v: m.results.EXCELLENT },
            { name: "Good", v: m.results.GOOD },
            { name: "Weak", v: m.results.WEAK },
            { name: "Poor", v: m.results.POOR },
          ]}
          x="name"
          series={[{ key: "v", name: "Миссий", color: CHART.series1 }]}
        />
      </ChartCard>
      <ChartCard title="Historical redistribution learning" subtitle="Маршруты: перенесено → продано. Слабые маршруты получают штраф в приоритете." className="lg:col-span-2">
        {m.pairs.length === 0 ? (
          <p className="text-[12px] text-ink-3">Появится после первых оценённых миссий (через 2 часа после выполнения).</p>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left">
                {["Маршрут", "Категория", "Перенесено", "Продано", "Успех"].map((h) => <th key={h} className="label pb-2">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {m.pairs.map((p) => (
                <tr key={p.route + p.category} className="border-t border-line">
                  <td className="py-1.5">{p.route}</td>
                  <td className="py-1.5">{categoryById(p.category as never).emoji} {categoryById(p.category as never).name}</td>
                  <td className="num py-1.5">{p.moved}</td>
                  <td className="num py-1.5">{p.sold}</td>
                  <td className={clsx("num py-1.5", p.rate >= 0.7 ? "text-good-ink" : p.rate < 0.4 ? "text-serious" : "text-ink")}>{pct(p.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ChartCard>
      <ChartCard title="Transfer history" subtitle="Последние выполненные миссии" className="lg:col-span-3">
        {m.history.length === 0 ? (
          <p className="text-[12px] text-ink-3">Пока пусто. Примите и выполните миссию на главном экране.</p>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left">
                {["#", "Время", "Маршрут", "Что", "Кто", "Результат"].map((h) => <th key={h} className="label pb-2">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {m.history.map((x) => (
                <tr key={x.id} className="border-t border-line">
                  <td className="num py-1.5 text-ink-3">{x.number}</td>
                  <td className="num py-1.5">{x.completedAt ? fmtClock(x.completedAt) : ""}</td>
                  <td className="py-1.5">{x.sourceName} → {x.stops.map((s) => x.stopNames?.[s.targetFridgeId]).join(" → ")}</td>
                  <td className="py-1.5">{x.lines.map((l) => `${categoryById(l.categoryId).emoji} ${l.actualQty ?? l.recommendedQty}/${l.recommendedQty}`).join("  ")}</td>
                  <td className="py-1.5 text-ink-2">{x.completedBy}</td>
                  <td className="py-1.5">
                    {x.evaluation ? (
                      <span className={x.evaluation.successRate >= 0.5 ? "text-good-ink" : "text-warn"}>
                        {x.evaluation.result} · {pct(x.evaluation.successRate)}
                      </span>
                    ) : (
                      <span className="text-ink-3">ждём 2 ч</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ChartCard>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="num mt-1 text-[22px] font-semibold">{value}</div>
    </div>
  );
}
