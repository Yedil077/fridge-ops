"use client";

import Link from "next/link";
import clsx from "clsx";
import { MobileShell } from "@/components/mobile/MobileShell";
import { RouteRow, SkeletonList, UrgencyPill, URGENCY, plural, routeTargets } from "@/components/mobile/ui";
import { useAlerts, useMobileHome } from "@/lib/client/mobileApi";
import { ModeToggle } from "@/lib/client/forecastMode";

export default function MobileHomePage() {
  const { data, error } = useMobileHome();
  const alerts = useAlerts();
  const alert = alerts.data?.notifications.find((n) => (alerts.data?.now ?? 0) - n.at < 60 * 60_000);

  if (error) return <MobileShell><p className="mt-10 text-center text-[15px] text-ink-2">{(error as Error).message}</p></MobileShell>;
  if (!data)
    return (
      <MobileShell>
        <ModeToggle className="mb-3" />
        <SkeletonList />
      </MobileShell>
    );

  const [top, ...rest] = data.routes;
  const mine = top && top.status !== "NEW";

  return (
    <MobileShell now={data.now}>
      <ModeToggle className="mb-3" />
      <section className="grid grid-cols-3 gap-2">
        <Count dot="🟢" n={data.counts.normal} label="нормально" />
        <Count dot="🟡" n={data.counts.attention} label="внимание" />
        <Count dot="🔴" n={data.counts.critical} label="срочно" tone={data.counts.critical > 0} />
      </section>

      <Link href="/m/scan" className="mt-3 flex h-14 items-center justify-center gap-2 rounded-2xl border border-line-strong bg-surface-2 text-[16px] font-bold active:bg-surface-3">
        📷 СКАНИРОВАТЬ · загрузка / разгрузка
      </Link>

      {alert && (
        <Link
          href={alert.missionId ? `/m/tasks/${alert.missionId}` : "/m/fridges"}
          className="mt-4 flex items-start gap-3 rounded-2xl border border-crit/40 bg-crit/10 px-4 py-3 active:bg-crit/20"
        >
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold leading-snug">{alert.title}</div>
            <div className="text-[13px] text-ink-3">{alert.body}</div>
          </div>
          <span className="text-[22px] text-ink-3">›</span>
        </Link>
      )}

      {top ? (
        <Link href={`/m/tasks/${top.id}`} className={clsx("card mt-4 block border-2 p-5 active:bg-surface-2", URGENCY[top.urgency].border)}>
          <div className="flex items-center justify-between">
            <UrgencyPill u={top.urgency} big />
            {mine && <span className="text-[13px] font-bold tracking-wider text-accent">МОЙ МАРШРУТ</span>}
          </div>
          <div className="mt-4 text-[26px] font-bold leading-tight">{top.sourceName}</div>
          <div className="my-1 text-[20px] text-ink-3">↓</div>
          <div className="text-[26px] font-bold leading-tight">{routeTargets(top)}</div>
          <div className="mt-3 text-[16px] text-ink-2">
            {top.totalItems} {plural(top.totalItems, "блюдо", "блюда", "блюд")} · примерно {Math.max(2, top.travelMinutes)} мин
          </div>
          <p className="mt-2 text-[15px] text-ink">{top.headline}</p>
          <div className="mt-5 flex h-14 items-center justify-center rounded-2xl bg-ink text-[17px] font-bold text-bg">{mine ? "ПРОДОЛЖИТЬ" : "ОТКРЫТЬ"}</div>
        </Link>
      ) : (
        <div className="card mt-4 p-6 text-center">
          <div className="text-[34px]">✓</div>
          <div className="mt-2 text-[18px] font-semibold">Сейчас ничего переносить не нужно</div>
          <div className="mt-1 text-[14px] text-ink-3">Система проверит холодильники снова через час.</div>
        </div>
      )}

      {rest.length > 0 && (
        <section className="mt-6">
          <h2 className="label mb-2 px-1">Следующие задачи</h2>
          <div className="space-y-2">
            {rest.slice(0, 4).map((r) => (
              <RouteRow key={r.id} r={r} />
            ))}
          </div>
          {rest.length > 4 && (
            <Link href="/m/tasks" className="mt-2 block py-3 text-center text-[15px] text-accent">
              Все задачи ({data.routes.length})
            </Link>
          )}
        </section>
      )}

      <Link href="/m/rating" className="card mt-6 block p-4 active:bg-surface-2">
        <div className="label">🏆 Сегодня</div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <div>
            <div className="num text-[24px] font-bold text-xp">{data.today.xpToday}</div>
            <div className="text-[12px] text-ink-3">XP</div>
          </div>
          <div>
            <div className="num text-[24px] font-bold">
              {data.today.done}
              <span className="text-[16px] text-ink-3"> / {data.today.total}</span>
            </div>
            <div className="text-[12px] text-ink-3">задач выполнено</div>
          </div>
          <div>
            <div className="num text-[24px] font-bold">{data.today.accuracy === null ? "—" : `${Math.round(data.today.accuracy * 100)}%`}</div>
            <div className="text-[12px] text-ink-3">точность</div>
          </div>
        </div>
        {data.player.streak >= 2 && <div className="mt-3 text-[14px] text-serious">🔥 {data.player.streak} задач подряд с хорошим результатом</div>}
      </Link>
    </MobileShell>
  );
}

function Count({ dot, n, label, tone }: { dot: string; n: number; label: string; tone?: boolean }) {
  return (
    <div className={clsx("card px-3 py-3", tone && "border-crit/50")}>
      <div className="flex items-center gap-1.5">
        <span className="text-[14px]">{dot}</span>
        <span className="num text-[24px] font-bold leading-none">{n}</span>
      </div>
      <div className="mt-1 text-[12px] text-ink-3">{label}</div>
    </div>
  );
}
