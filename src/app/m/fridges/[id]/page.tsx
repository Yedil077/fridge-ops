"use client";

import { use } from "react";
import clsx from "clsx";
import Link from "next/link";
import { MobileShell } from "@/components/mobile/MobileShell";
import { DataSourceBadge } from "@/components/DataSourceBadge";
import { SkeletonList } from "@/components/mobile/ui";
import { useMobileFridge } from "@/lib/client/mobileApi";

const STATUS = {
  critical: { label: "🔴 СРОЧНО", cls: "text-crit-ink" },
  attention: { label: "🟡 ВНИМАНИЕ", cls: "text-warn" },
  normal: { label: "🟢 НОРМА", cls: "text-good-ink" },
  closed: { label: "⚪ ЗАКРЫТ", cls: "text-ink-3" },
} as const;

const STATE_TAG: Record<string, string> = {
  EMPTY_RISK: "скоро закончится",
  LOW_STOCK: "мало",
  OVERSTOCK: "избыток",
  WASTE_RISK: "риск списания",
};

export default function MobileFridgePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error, refetch, isFetching } = useMobileFridge(id);
  if (error) return <MobileShell back="/m/fridges" title="Холодильник"><p className="mt-10 text-center text-ink-2">{(error as Error).message}</p></MobileShell>;
  if (!data) return <MobileShell back="/m/fridges" title="Холодильник"><SkeletonList /></MobileShell>;
  const st = STATUS[data.status];
  return (
    <MobileShell back="/m/fridges" title={data.name} now={data.now}>
      <div className="card p-4">
        <div className="text-[28px] font-extrabold">{data.name}</div>
        <div className="text-[14px] text-ink-3">
          {data.location} · {data.hours}
        </div>
        <div className={clsx("mt-2 text-[15px] font-bold tracking-wide", st.cls)}>{st.label}</div>
        <div className="mt-1 text-[14px] text-ink-3">Продано сегодня: {data.salesToday}</div>
        <div className="mt-2 flex items-center justify-between text-[13px] text-ink-3">
          <DataSourceBadge />
          <button onClick={() => refetch()} className="h-10 rounded-xl bg-surface-3 px-3 font-semibold text-accent">
            {isFetching ? "…" : "ОБНОВИТЬ"}
          </button>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {data.categories.map((c) => (
          <section key={c.id} className="card overflow-hidden">
            <div className="flex items-center gap-3 border-b border-line px-4 py-3" style={{ boxShadow: `inset 4px 0 0 ${c.color}` }}>
              <span className="text-[20px]">{c.emoji}</span>
              <span className="flex-1 text-[16px] font-bold uppercase tracking-wide">{c.name}</span>
              <span className="num text-[22px] font-bold">{c.stock}</span>
            </div>
            {(c.note || STATE_TAG[c.state]) && (
              <div className={clsx("px-4 pt-2 text-[13px]", c.state === "EMPTY_RISK" ? "text-crit-ink" : c.state === "LOW_STOCK" ? "text-warn" : "text-ink-3")}>
                {c.note ?? STATE_TAG[c.state]}
              </div>
            )}
            <ul className="px-4 py-2">
              {c.products.length === 0 ? (
                <li className="py-2 text-[15px] text-ink-3">Нет в наличии</li>
              ) : (
                c.products.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 border-b border-line py-2.5 last:border-0">
                    <span className="flex-1 text-[16px]">{p.name}</span>
                    <span className="rounded bg-surface-3 px-1.5 py-px font-mono text-[11px] text-ink-3">{p.sku}</span>
                    <span className="num w-8 text-right text-[18px] font-bold">{p.qty}</span>
                  </li>
                ))
              )}
            </ul>
          </section>
        ))}
      </div>
    </MobileShell>
  );
}
