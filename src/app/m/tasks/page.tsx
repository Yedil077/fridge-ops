"use client";

import { MobileShell } from "@/components/mobile/MobileShell";
import { RouteRow, SkeletonList, routeTargets } from "@/components/mobile/ui";
import { useMobileTasks } from "@/lib/client/mobileApi";
import { ModeToggle } from "@/lib/client/forecastMode";
import { fmtClock } from "@/lib/client/format";

export default function MobileTasksPage() {
  const { data } = useMobileTasks();
  if (!data) return <MobileShell title="Перемещения"><SkeletonList /></MobileShell>;
  return (
    <MobileShell title="Перемещения" now={data.now}>
      <ModeToggle className="mb-3" />
      {data.open.length === 0 ? (
        <div className="card p-6 text-center text-[15px] text-ink-2">Открытых задач нет. Система проверит холодильники через час.</div>
      ) : (
        <div className="space-y-2">
          {data.open.map((r) => (
            <RouteRow key={r.id} r={r} />
          ))}
        </div>
      )}

      {data.done.length > 0 && (
        <section className="mt-8">
          <h2 className="label mb-2 px-1">Сегодня закрыто</h2>
          <div className="space-y-2">
            {data.done.map((r) => (
              <div key={r.id} className="card flex items-center gap-3 px-4 py-3">
                <span className={r.status === "COMPLETED" ? "text-[18px] text-good-ink" : "text-[18px] text-ink-3"}>{r.status === "COMPLETED" ? "✓" : "–"}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px]">
                    {r.sourceName} → {routeTargets(r)}
                  </div>
                  <div className="text-[13px] text-ink-3">
                    {r.completedAt ? fmtClock(r.completedAt) : "пропущена"}
                    {r.evaluation ? ` · продано ${r.evaluation.lines.reduce((a, l) => a + l.soldAttributed, 0)} из ${r.evaluation.lines.reduce((a, l) => a + l.moved, 0)}` : r.status === "COMPLETED" ? " · результат через 2 ч" : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </MobileShell>
  );
}
