"use client";

import Link from "next/link";
import clsx from "clsx";
import { MobileShell } from "@/components/mobile/MobileShell";
import { SkeletonList } from "@/components/mobile/ui";
import { useMobileAnalytics } from "@/lib/client/mobileApi";
import { fmtMoney } from "@/lib/client/format";

const DOT = { critical: "🔴", attention: "🟡", normal: "🟢", closed: "⚪" } as const;

/** Аналитика: today per point and for the network. Nothing here changes KiT Shop. */
export default function MobileAnalyticsPage() {
  const { data, error } = useMobileAnalytics();
  if (error) return <MobileShell title="Аналитика"><p className="mt-10 text-center text-[15px] text-ink-2">{(error as Error).message}</p></MobileShell>;
  if (!data) return <MobileShell title="Аналитика"><SkeletonList /></MobileShell>;
  const n = data.network;
  const pace = n.typicalDay > 0 ? Math.round((n.projectedDay / n.typicalDay) * 100) : null;
  return (
    <MobileShell title="Аналитика" now={data.now}>
      <section className="grid grid-cols-2 gap-2">
        <Kpi label="Продано сегодня" value={String(n.salesToday)} sub={n.revenueToday ? fmtMoney(n.revenueToday) : undefined} />
        <Kpi label="За последний час" value={String(n.salesLastHour)} />
        <Kpi label="Прогноз 1 ч / 2 ч" value={`${Math.round(n.expected1h)} / ${Math.round(n.expected2h)}`} />
        <Kpi label="К концу дня" value={String(n.projectedDay)} sub={pace !== null ? `${pace}% от обычного дня` : undefined} />
        <Kpi label="Риск дефицита" value={`${n.deficitPoints} точ.`} tone={n.deficitPoints > 0 ? "crit" : undefined} />
        <Kpi label="Риск излишка" value={`${n.surplusPoints} точ.`} tone={n.surplusPoints > 0 ? "warn" : undefined} />
      </section>

      <h2 className="label mb-2 mt-6 px-1">Точки · сегодня</h2>
      <div className="space-y-2">
        {data.fridges.map((f) => (
          <Link key={f.id} href={`/m/fridges/${f.id}`} className={clsx("card block px-4 py-3 active:bg-surface-2", !f.isOpenNow && "opacity-70")}>
            <div className="flex items-center gap-2">
              <span className="text-[14px]">{DOT[f.status]}</span>
              <span className="min-w-0 flex-1 truncate text-[16px] font-semibold">{f.name}</span>
              <span className="num text-[18px] font-bold">{f.salesToday}</span>
            </div>
            <div className="mt-1 grid grid-cols-4 gap-1 text-[12px] text-ink-3">
              <span>час: <b className="num text-ink">{f.salesLastHour}</b></span>
              <span>+1ч: <b className="num text-ink">{Math.round(f.expected1h)}</b></span>
              <span>+2ч: <b className="num text-ink">{Math.round(f.expected2h)}</b></span>
              <span>остаток: <b className="num text-ink">{f.stock}</b></span>
            </div>
            {(f.deficit.length > 0 || f.surplus.length > 0) && (
              <div className="mt-1 text-[12px]">
                {f.deficit.length > 0 && <span className="text-crit-ink">дефицит: {f.deficit.join(", ")} </span>}
                {f.surplus.length > 0 && <span className="text-warn">излишек: {f.surplus.join(", ")}</span>}
              </div>
            )}
          </Link>
        ))}
      </div>

      <h2 className="label mb-2 mt-6 px-1">Категории · продано / в наличии</h2>
      <div className="card divide-y divide-line">
        {data.categories.map((c) => (
          <div key={c.id} className="flex items-center gap-3 px-4 py-2.5 text-[14px]" style={{ boxShadow: `inset 3px 0 0 ${c.color}` }}>
            <span>{c.emoji}</span>
            <span className="flex-1">{c.name}</span>
            <span className="num font-semibold">{c.sales}</span>
            <span className="num w-14 text-right text-ink-3">{c.stock}</span>
          </div>
        ))}
      </div>

      <h2 className="label mb-2 mt-6 px-1">Топ блюд сегодня</h2>
      {data.top.length === 0 ? (
        <p className="card p-4 text-[14px] text-ink-3">Сегодня продаж ещё нет.</p>
      ) : (
        <div className="card divide-y divide-line">
          {data.top.map((p, i) => (
            <div key={p.id} className="flex items-center gap-3 px-4 py-2.5 text-[14px]">
              <span className="num w-5 text-ink-3">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="num font-semibold">{p.qty}</span>
              <span className="num w-16 text-right text-[12px] text-ink-3">ост. {p.stock}</span>
            </div>
          ))}
        </div>
      )}
      <p className="mt-4 px-1 text-[12px] text-ink-3">Данные KiT Shop только читаются. Отметки по задачам хранятся в Apps Холодосов.</p>
    </MobileShell>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "crit" | "warn" }) {
  return (
    <div className={clsx("card px-3 py-3", tone === "crit" && "border-crit/50", tone === "warn" && "border-warn/50")}>
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="num mt-1 text-[22px] font-bold leading-none">{value}</div>
      {sub && <div className="mt-1 text-[11px] text-ink-3">{sub}</div>}
    </div>
  );
}
