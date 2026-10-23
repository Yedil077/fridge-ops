"use client";

import clsx from "clsx";
import { Shell } from "@/components/Shell";
import { MissionCard } from "@/components/MissionCard";
import { FridgeCard } from "@/components/FridgeCard";
import { useDashboard, type DashboardView } from "@/lib/client/api";
import { ModeToggle } from "@/lib/client/forecastMode";
import { fmtClock } from "@/lib/client/format";

/**
 * Главная: где чего мало, где много, что забрать, сколько и куда. Только рабочие данные — без наград и второстепенных KPI.
 */
export default function CommandCenter() {
  const { data, error, isLoading } = useDashboard();

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
        <div className="mt-24 text-center text-[13px] text-ink-3">Загружаю данные холодильников…</div>
      </Shell>
    );
  }

  return (
    <Shell now={data.now} mode={data.mode}>
      <TopStrip d={data} />

      <section className="mt-5">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="label">Перемещения</h2>
          <ModeToggle size="sm" className="w-[260px]" />
          <span className="text-[11px] text-ink-3">{data.lastAnalysisAt ? `пересчитано в ${fmtClock(data.lastAnalysisAt)} · обновляется каждый час` : ""}</span>
        </div>
        {data.missions.open.length === 0 ? (
          <div className="card flex items-center gap-4 p-6">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-good/15 text-good-ink">✓</span>
            <div>
              <div className="text-[15px] font-semibold">Сейчас ничего переносить не нужно</div>
              <div className="text-[13px] text-ink-3">Следующая проверка — через час.</div>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            {data.missions.open.map((m) => (
              <MissionCard key={m.id} mission={m} />
            ))}
          </div>
        )}
      </section>

      <section className="mt-8">
        <div className="mb-3 flex items-baseline gap-3">
          <h2 className="label">Холодильники</h2>
          <span className="text-[11px] text-ink-3">нажмите на карточку — остатки по блюдам</span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          {data.fridges.map((f) => (
            <FridgeCard key={f.id} f={f} />
          ))}
        </div>
      </section>
    </Shell>
  );
}

function TopStrip({ d }: { d: DashboardView }) {
  const n = d.network;
  return (
    <section className="card grid grid-cols-2 gap-px overflow-hidden bg-line p-0 sm:grid-cols-3 lg:grid-cols-6">
      <Kpi label="🟢 Норма" value={String(n.normal)} sub={n.closed ? `ещё ${n.closed} без продаж сейчас` : `из ${n.fridgesTotal} холодильников`} tone="good" />
      <Kpi label="🟡 Нужно внимание" value={String(n.attention)} tone={n.attention ? "warn" : undefined} />
      <Kpi label="🔴 Срочно" value={String(n.critical)} tone={n.critical ? "crit" : undefined} />
      <Kpi label="Остаток в сети" value={String(n.totalStock)} sub="блюд" />
      <Kpi label="Продано сегодня" value={String(n.salesToday)} />
      <Kpi label="За последний час" value={String(n.salesLastHour)} />
    </section>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "warn" | "crit" }) {
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
      {sub && <div className="mt-1.5 text-[11px] text-ink-3">{sub}</div>}
    </div>
  );
}
