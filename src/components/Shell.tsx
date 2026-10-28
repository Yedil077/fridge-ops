"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import clsx from "clsx";
import { atLeast, logout, useMe } from "@/lib/client/api";
import { fmtDay } from "@/lib/client/format";
import { LiveClock } from "@/components/LiveClock";
import { DataSourceBadge } from "@/components/DataSourceBadge";

const NAV = [
  { href: "/", label: "Главная", short: "🏠", role: "MANAGER" as const },
  { href: "/tomorrow", label: "Tomorrow", short: "📅", role: "MANAGER" as const },
  { href: "/analytics", label: "Аналитика", short: "📊", role: "MANAGER" as const },
  { href: "/reports/unused", label: "Неиспользуемые блюда", short: "📄", role: "MANAGER" as const },
  { href: "/admin", label: "Настройки", short: "⚙️", role: "ADMIN" as const },
];

export function Shell({
  children,
  now,
  mode,
}: {
  children: ReactNode;
  now?: number;
  mode?: string;
}) {
  const path = usePathname();
  const { data: me } = useMe();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1480px] items-center gap-4 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-lg border border-line-strong bg-surface-2 text-[13px]">❄</span>
            <span className="hidden sm:inline">Apps Холодосов</span>
          </Link>
          <nav className="flex items-center gap-1">
            {NAV.filter((n) => atLeast(me, n.role)).map((n) => {
              const active = n.href === "/" ? path === n.href : path.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={clsx(
                    "whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px] transition-colors sm:px-3",
                    active ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink",
                  )}
                >
                  <span className="hidden xl:inline">{n.label}</span>
                  <span className="xl:hidden" title={n.label}>{n.short}</span>
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <DataSourceBadge />
            {now !== undefined && (
              <div className="flex items-center gap-2 whitespace-nowrap rounded-md border border-line bg-surface px-2.5 py-1 text-[12px]">
                {mode === "mock" && <span className="rounded bg-accent/15 px-1.5 py-px text-[10px] font-semibold tracking-wider text-accent md:hidden">SIM</span>}
                <span className="hidden text-ink-3 sm:inline">{fmtDay(now)}</span>
                <LiveClock serverNow={now} className="num font-mono text-ink" />
              </div>
            )}
            <button
              onClick={() => {
                document.cookie = "fo_view=; path=/; max-age=0";
                window.location.href = "/m";
              }}
              className="hidden rounded-md px-2 py-1 text-[12px] text-ink-3 hover:text-ink sm:block"
              title="Интерфейс сотрудника для телефона"
            >
              📱 Мобильная
            </button>
            <button onClick={logout} className="rounded-md px-2 py-1 text-[12px] text-ink-3 hover:text-ink">
              Выйти
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1480px] px-4 pb-24 pt-5 sm:px-6">{children}</main>
    </div>
  );
}
