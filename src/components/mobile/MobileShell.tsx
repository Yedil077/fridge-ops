"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import clsx from "clsx";
import { useQueryClient } from "@tanstack/react-query";
import { atLeast, logout, useMe } from "@/lib/client/api";
import { flushOutbox, outboxSize } from "@/lib/client/offline";
import { LiveClock } from "@/components/LiveClock";
import { DataSourceBadge } from "@/components/DataSourceBadge";

const TABS = [
  { href: "/m", label: "Сегодня", icon: "🏠" },
  { href: "/m/tasks", label: "Задачи", icon: "✅" },
  { href: "/m/fridges", label: "Холодильники", icon: "🧊" },
  { href: "/m/analytics", label: "Аналитика", icon: "📊" },
];

/** Staff (phone) layout: slim top bar, content, bottom tab bar. Safe-area aware for iPhone. */
export function MobileShell({ children, now, title, back }: { children: ReactNode; now?: number; title?: string; back?: string }) {
  const path = usePathname();
  const qc = useQueryClient();
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [menu, setMenu] = useState(false);
  const { data: me } = useMe();

  useEffect(() => {
    const sync = async () => {
      setOnline(navigator.onLine);
      if (navigator.onLine && outboxSize() > 0) {
        const sent = await flushOutbox();
        if (sent) qc.invalidateQueries();
      }
      setPending(outboxSize());
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        sync();
        qc.invalidateQueries();
      }
    };
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    document.addEventListener("visibilitychange", onVisible); // also fires when the Android app resumes
    const t = setInterval(sync, 20_000);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(t);
    };
  }, [qc]);

  return (
    <div className="min-h-[100dvh] bg-bg pb-[calc(76px+env(safe-area-inset-bottom))]">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/90 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="flex h-14 items-center gap-3 px-4">
          {back ? (
            <Link href={back} className="-ml-2 grid h-11 w-11 place-items-center rounded-xl text-[22px] text-ink-2 active:bg-surface-2" aria-label="Назад">
              ‹
            </Link>
          ) : null}
          <div className="min-w-0 flex-1">
            {title ? (
              <div className="truncate text-[17px] font-semibold">{title}</div>
            ) : (
              <div className="text-[15px] font-bold tracking-[0.14em]">APPS ХОЛОДОСОВ</div>
            )}
          </div>
          {now !== undefined && <LiveClock serverNow={now} className="num font-mono text-[15px] text-ink-2" />}
          <button onClick={() => setMenu(!menu)} className="grid h-11 w-11 place-items-center rounded-xl text-[20px] text-ink-2 active:bg-surface-2" aria-label="Меню">
            ⋯
          </button>
        </div>
        <div className="flex justify-end px-4 pb-1.5">
          <DataSourceBadge />
        </div>
        {(!online || pending > 0) && (
          <div className={clsx("px-4 py-2 text-[13px]", online ? "bg-accent/15 text-accent" : "bg-warn/15 text-warn")}>
            {online ? `Отправляю сохранённые действия: ${pending}` : "Нет связи — отметки сохраняются на телефоне и отправятся позже"}
          </div>
        )}
        {menu && (
          <div className="absolute right-3 top-[calc(56px+env(safe-area-inset-top))] z-40 w-60 overflow-hidden rounded-2xl border border-line-strong bg-surface-2 shadow-2xl">
            {me && (
              <div className="border-b border-line px-4 py-3 text-[13px] text-ink-3">
                {me.name} · {me.role === "ADMIN" ? "администратор" : me.role === "MANAGER" ? "менеджер" : "сотрудник"}
              </div>
            )}
            {me && me.readOnly === false && (
              <>
                <Link href="/m/scan" className="block min-h-12 px-4 py-3.5 text-[15px] active:bg-surface-3">📷 Сканировать</Link>
                <Link href="/m/sync" className="block min-h-12 px-4 py-3.5 text-[15px] active:bg-surface-3">
                  🔄 {atLeast(me, "MANAGER") ? "Синхронизация KiT Shop" : "Мои операции"}
                </Link>
              </>
            )}
            {atLeast(me, "MANAGER") && (
              <a href="/api/admin/reports/unused-products?download=1" className="block min-h-12 px-4 py-3.5 text-[15px] active:bg-surface-3">
                📄 Что удалить из KiT Shop (Excel)
              </a>
            )}
            {me?.rewards && <Link href="/m/rating" className="block min-h-12 px-4 py-3.5 text-[15px] active:bg-surface-3">🏆 Награды</Link>}
            {atLeast(me, "MANAGER") && (
              <button
                onClick={() => {
                  document.cookie = "fo_view=desktop; path=/; max-age=31536000";
                  window.location.href = "/";
                }}
                className="block min-h-12 w-full px-4 py-3.5 text-left text-[15px] active:bg-surface-3"
              >
                🖥 Полная версия
              </button>
            )}
            {atLeast(me, "ADMIN") && (
              <>
                <Link href="/analytics" className="block min-h-12 px-4 py-3.5 text-[15px] active:bg-surface-3">📊 Analytics</Link>
                <Link href="/admin/products" className="block min-h-12 px-4 py-3.5 text-[15px] active:bg-surface-3">🏷 Товары</Link>
                <Link href="/admin" className="block min-h-12 px-4 py-3.5 text-[15px] active:bg-surface-3">⚙️ Настройки</Link>
              </>
            )}
            <button onClick={logout} className="block min-h-12 w-full border-t border-line px-4 py-3.5 text-left text-[15px] text-ink-3 active:bg-surface-3">
              Выйти
            </button>
          </div>
        )}
      </header>

      <main className="mx-auto max-w-xl px-4 pt-4">{children}</main>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <div className="mx-auto grid max-w-xl grid-cols-4">
          {TABS.map((t) => {
            const active = t.href === "/m" ? path === "/m" : path.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={clsx("flex h-[64px] flex-col items-center justify-center gap-0.5 text-[11px]", active ? "text-ink" : "text-ink-3")}
              >
                <span className={clsx("text-[22px] leading-none", !active && "opacity-60 grayscale")}>{t.icon}</span>
                <span className={clsx(active && "font-semibold")}>{t.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
