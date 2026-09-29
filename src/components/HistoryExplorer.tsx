"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import { BarsChart, ChartCard, CHART, LinesChart } from "@/components/charts";
import { useHistory, type HistoryView } from "@/lib/client/api";
import { signed } from "@/lib/client/format";
import { CATEGORY_COLORS } from "@/lib/domain/categories";

const RANGES = [
  { v: 7, label: "7 DAYS" },
  { v: 30, label: "30 DAYS" },
  { v: 90, label: "90 DAYS" },
  { v: 180, label: "6 MONTHS" },
];
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export function HistoryExplorer() {
  const [range, setRange] = useState(90);
  const [fridge, setFridge] = useState<string | null>(null);
  const { data, isFetching } = useHistory(range, fridge);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {RANGES.map((r) => (
          <button
            key={r.v}
            onClick={() => setRange(r.v)}
            className={clsx("rounded-md border px-3 py-1.5 font-mono text-[11px]", range === r.v ? "border-accent/50 bg-accent/10 text-ink" : "border-line text-ink-3 hover:text-ink")}
          >
            {r.label}
          </button>
        ))}
        <select
          value={fridge ?? ""}
          onChange={(e) => setFridge(e.target.value || null)}
          className="ml-2 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-[12px] text-ink outline-none"
        >
          <option value="">Вся сеть</option>
          {data?.fridges.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
        {isFetching && <span className="text-[11px] text-ink-3">обновляю…</span>}
      </div>
      {!data ? <p className="text-[13px] text-ink-3">Загружаю историю…</p> : <HistoryBody d={data} />}
    </div>
  );
}

function HistoryBody({ d }: { d: HistoryView }) {
  const [picked, setPicked] = useState<string | null>(null);
  const trend = useMemo(() => {
    // 7-day moving average over open days keeps the line readable
    return d.daily.map((x, i) => {
      const win = d.daily.slice(Math.max(0, i - 6), i + 1).filter((y) => y.total > 0);
      return { label: x.date.slice(5), total: x.total || null, avg7: win.length ? Math.round(win.reduce((a, y) => a + y.total, 0) / win.length) : null };
    });
  }, [d.daily]);
  const totalAll = d.catTotals.reduce((a, c) => a + c.total, 0) || 1;
  const pickedDay = d.daily.find((x) => x.date === picked) ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartCard title="Calendar heatmap" subtitle="Чем ярче — тем выше спрос. Нажмите на день." className="lg:col-span-2">
        <Calendar days={d.daily} picked={picked} onPick={setPicked} />
        {pickedDay && (
          <div className="mt-4 grid gap-3 rounded-xl border border-line bg-surface-2 p-4 text-[12px] sm:grid-cols-4">
            <div>
              <div className="label">{pickedDay.date} · {WD[pickedDay.weekday - 1]}</div>
              <div className="num mt-1 text-[22px] font-semibold">{pickedDay.total}</div>
              <div className="text-ink-3">продаж{pickedDay.holiday ? " · праздник" : ""}</div>
            </div>
            <div>
              <div className="label mb-1">По категориям</div>
              {d.categories.map((c, i) => (
                <div key={c.id} className="flex justify-between"><span className="text-ink-3">{c.emoji} {c.name}</span><span className="num">{pickedDay.categories[i]}</span></div>
              ))}
            </div>
            <div>
              <div className="label mb-1">Пик</div>
              <div className="num text-[16px]">{pickedDay.peakHour === null ? "—" : `${String(pickedDay.peakHour).padStart(2, "0")}:00–${String(pickedDay.peakHour + 1).padStart(2, "0")}:00`}</div>
              <div className="label mb-1 mt-3">Открыто точек</div>
              <div className="num">{pickedDay.open}</div>
            </div>
            <div>
              <div className="label mb-1">Миссии</div>
              <div className="num">{pickedDay.missionsCompleted} / {pickedDay.missions}</div>
              <div className="label mb-1 mt-3">Списано</div>
              <div className="num">{pickedDay.waste === null ? "нет данных" : pickedDay.waste}</div>
            </div>
          </div>
        )}
      </ChartCard>

      <ChartCard title="Sales trend" subtitle={`${d.fridge ? d.fridge.name : "Вся сеть"} · продажи в день и скользящее среднее 7 дней`} className="lg:col-span-2">
        <LinesChart
          data={trend}
          x="label"
          series={[
            { key: "total", name: "За день", color: CHART.reference },
            { key: "avg7", name: "Среднее 7 дней", color: CHART.series1 },
          ]}
          height={240}
        />
      </ChartCard>

      <ChartCard title="Category mix" subtitle="Доля продаж за период">
        <div className="flex h-3 overflow-hidden rounded-full">
          {d.catTotals.map((c) => (
            <div key={c.id} style={{ width: `${(c.total / totalAll) * 100}%`, background: CATEGORY_COLORS[c.id as keyof typeof CATEGORY_COLORS] }} className="border-r-2 border-surface last:border-0" />
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
          {d.catTotals.map((c) => (
            <div key={c.id} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: CATEGORY_COLORS[c.id as keyof typeof CATEGORY_COLORS] }} />
              <span className="text-ink-2">{c.emoji} {c.name}</span>
              <span className="num ml-auto">{Math.round((c.total / totalAll) * 100)}%</span>
            </div>
          ))}
        </div>
      </ChartCard>

      <ChartCard title="Demand changes" subtitle="Первая половина периода → вторая, продаж в рабочий день">
        <table className="w-full text-[12px]">
          <tbody>
            {d.changes.map((c) => (
              <tr key={c.id} className="border-b border-line last:border-0">
                <td className="py-1.5 text-ink-2">{c.emoji} {c.name}</td>
                <td className="num py-1.5 text-right text-ink-3">{c.before}</td>
                <td className="num py-1.5 text-right">{c.after}</td>
                <td className={clsx("num py-1.5 text-right", c.changePct >= 10 ? "text-good-ink" : c.changePct <= -10 ? "text-serious" : "text-ink-3")}>{signed(c.changePct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ChartCard>

      <ChartCard title="Hourly demand" subtitle="Средние продажи по часам в рабочий день">
        <BarsChart data={d.hourly} x="label" denseX series={[{ key: "avg", name: "Продаж/час", color: CHART.series1 }]} />
      </ChartCard>
      <ChartCard title="Weekday pattern" subtitle="Средние продажи за день">
        <BarsChart data={d.weekday} x="name" series={[{ key: "avg", name: "Продаж/день", color: CHART.series1 }]} />
      </ChartCard>

      <ChartCard title="Top / weak products" subtitle="Штук в рабочий день">
        <div className="grid grid-cols-2 gap-4 text-[12px]">
          <div>
            <div className="mb-2 text-good-ink">Лидеры</div>
            {d.topProducts.map((p, i) => (
              <div key={p.name} className="flex justify-between py-1"><span className="text-ink-2">{i + 1}. {p.name}</span><span className="num">{p.perDay}</span></div>
            ))}
          </div>
          <div>
            <div className="mb-2 text-serious">Слабые</div>
            {d.weakProducts.map((p, i) => (
              <div key={p.name} className="flex justify-between py-1"><span className="text-ink-2">{i + 1}. {p.name}</span><span className="num">{p.perDay}</span></div>
            ))}
          </div>
        </div>
      </ChartCard>
      <ChartCard title="Transfer effectiveness" subtitle="Миссии за период">
        <div className="grid grid-cols-3 gap-4">
          <div><div className="label">Миссий</div><div className="num mt-1 text-[22px] font-semibold">{d.transfers.count}</div></div>
          <div><div className="label">Перенесено</div><div className="num mt-1 text-[22px] font-semibold">{d.transfers.moved}</div></div>
          <div><div className="label">Продано после</div><div className="num mt-1 text-[22px] font-semibold">{d.transfers.sold}</div></div>
        </div>
      </ChartCard>
    </div>
  );
}

function Calendar({ days, picked, onPick }: { days: HistoryView["daily"]; picked: string | null; onPick: (d: string) => void }) {
  const max = Math.max(1, ...days.map((d) => d.total));
  // columns = weeks, rows = Mon..Sun
  const lead = days.length ? days[0].weekday - 1 : 0;
  const cells: (HistoryView["daily"][number] | null)[] = [...Array(lead).fill(null), ...days];
  const weeks = Math.ceil(cells.length / 7);
  const color = (v: number) => {
    if (v <= 0) return "#1a1b1f";
    const t = Math.sqrt(v / max);
    const a = [34, 36, 42];
    const b = [109, 167, 236];
    return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(",")})`;
  };
  return (
    <div className="overflow-x-auto">
      <div className="flex gap-3">
        <div className="grid grid-rows-7 gap-[3px] pt-0 text-[10px] text-ink-3">
          {WD.map((w) => <div key={w} className="h-[14px] leading-[14px]">{w}</div>)}
        </div>
        <div className="grid grid-flow-col gap-[3px]" style={{ gridTemplateRows: "repeat(7, 14px)", gridTemplateColumns: `repeat(${weeks}, 14px)` }}>
          {cells.map((d, i) =>
            d ? (
              <button
                key={d.date}
                title={`${d.date}: ${d.total} продаж${d.holiday ? " (праздник)" : ""}`}
                onClick={() => onPick(d.date)}
                className={clsx("h-[14px] w-[14px] rounded-[3px]", picked === d.date && "ring-2 ring-ink")}
                style={{ background: color(d.total) }}
              />
            ) : (
              <div key={`e${i}`} />
            ),
          )}
        </div>
      </div>
    </div>
  );
}
