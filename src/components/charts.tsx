"use client";

import type { ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";

/** Chart tokens (dark surface). Series colors come from the validated categorical palette, fixed order. */
export const CHART = {
  grid: "#26282e",
  axis: "#7c7e84",
  series1: "#3987e5",
  series2: "#d95926",
  reference: "#7c7e84",
  surface: "#1a1b1f",
};

export function ChartCard({ title, subtitle, children, className }: { title: string; subtitle?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`card p-4 ${className ?? ""}`}>
      <div className="mb-3">
        <div className="label">{title}</div>
        {subtitle && <div className="mt-1 text-[12px] text-ink-3">{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

function DarkTooltip({ active, payload, label }: TooltipProps<number, string> & { payload?: { name: string; value: number; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-[12px] shadow-xl">
      <div className="mb-1 text-ink-3">{label}</div>
      {payload
        .filter((p) => p.value !== null && p.value !== undefined)
        .map((p) => (
          <div key={p.name} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
            <span className="text-ink-2">{p.name}</span>
            <span className="num ml-auto pl-3 text-ink">{Math.round(p.value * 10) / 10}</span>
          </div>
        ))}
    </div>
  );
}

const axisProps = {
  stroke: CHART.axis,
  tick: { fill: CHART.axis, fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: CHART.grid },
} as const;

export interface LineSeries {
  key: string;
  name: string;
  color: string;
  dashed?: boolean;
}

export function LinesChart({ data, x, series, height = 240 }: { data: object[]; x: string; series: LineSeries[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid stroke={CHART.grid} vertical={false} />
        <XAxis dataKey={x} {...axisProps} interval="preserveStartEnd" minTickGap={16} />
        <YAxis {...axisProps} allowDecimals={false} />
        <Tooltip content={<DarkTooltip />} cursor={{ stroke: CHART.axis, strokeDasharray: "3 3" }} />
        <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: "#b4b5b8", paddingTop: 6 }} />
        {series.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={s.color}
            strokeWidth={2}
            strokeDasharray={s.dashed ? "5 4" : undefined}
            dot={false}
            activeDot={{ r: 4, stroke: CHART.surface, strokeWidth: 2 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function BarsChart({
  data,
  x,
  series,
  height = 220,
  layout = "horizontal",
  denseX = false,
}: {
  data: object[];
  x: string;
  series: { key: string; name: string; color: string }[];
  height?: number;
  layout?: "horizontal" | "vertical";
  /** many x labels (e.g. hours) — let the axis skip some */
  denseX?: boolean;
}) {
  const vertical = layout === "vertical";
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout={vertical ? "vertical" : "horizontal"} margin={{ top: 6, right: 8, bottom: 0, left: vertical ? 0 : -18 }} barGap={2}>
        <CartesianGrid stroke={CHART.grid} vertical={vertical} horizontal={!vertical} />
        {vertical ? (
          <>
            <XAxis type="number" {...axisProps} allowDecimals={false} />
            <YAxis type="category" dataKey={x} {...axisProps} width={56} />
          </>
        ) : (
          <>
            <XAxis dataKey={x} {...axisProps} interval={denseX ? "preserveStartEnd" : 0} minTickGap={denseX ? 12 : 2} />
            <YAxis {...axisProps} allowDecimals={false} />
          </>
        )}
        <Tooltip content={<DarkTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
        {series.length > 1 && <Legend iconType="square" wrapperStyle={{ fontSize: 12, color: "#b4b5b8", paddingTop: 6 }} />}
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} radius={vertical ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
