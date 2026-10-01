"use client";

import { useState } from "react";
import clsx from "clsx";
import { useDevAction } from "@/lib/client/api";
import { fmtClock } from "@/lib/client/format";

const ACTIONS: { id: string; label: string; hint: string; tone?: "danger" }[] = [
  { id: "advance15", label: "+15 MIN", hint: "Продвинуть время" },
  { id: "advance60", label: "SIMULATE +1 HOUR", hint: "Час продаж + часовой анализ" },
  { id: "advance180", label: "+3 HOURS", hint: "Три часа" },
  { id: "to-close", label: "⏭ ДО ЧАСА «ДО»", hint: "Прокрутить время до часа режима «ДО HH:MM» (Настройки)" },
  { id: "now", label: "⏮ СЕЙЧАС", hint: "Вернуться к реальному текущему времени" },
  { id: "sales", label: "SIMULATE SALES", hint: "Всплеск ~30 мин спроса" },
  { id: "shortage", label: "CREATE SHORTAGE", hint: "Обнулить популярную категорию" },
  { id: "overstock", label: "CREATE OVERSTOCK", hint: "+14 шт. непопулярной категории" },
  { id: "anomaly", label: "DEMAND ANOMALY", hint: "Спрос ×1.9 в одной точке" },
  { id: "analyze", label: "RUN ANALYSIS", hint: "Пересчитать миссии сейчас" },
  { id: "ks-slow", label: "KS: SLOW 5s", hint: "Следующая операция подтвердится через 5 секунд" },
  { id: "ks-timeout", label: "KS: TIMEOUT", hint: "Тренировочный KiT Shop не ответит на следующую операцию" },
  { id: "ks-lost", label: "KS: LOST ANSWER", hint: "Следующая операция пройдёт, но ответ потеряется" },
  { id: "ks-reject", label: "KS: ERROR", hint: "Следующая операция будет отклонена" },
  { id: "ks-offline", label: "KS: OFFLINE", hint: "Следующая операция: KiT Shop недоступен" },
  { id: "reset-day", label: "RESET DAY", hint: "Вернуть день к утру", tone: "danger" },
  { id: "reseed", label: "NEW WORLD", hint: "Новые данные (seed)", tone: "danger" },
];

export function DevPanel() {
  const [open, setOpen] = useState(false);
  const dev = useDevAction();
  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        className="fixed bottom-5 right-5 z-40 rounded-full border border-line-strong bg-surface-2 px-4 py-2 font-mono text-[12px] text-ink-2 shadow-xl hover:text-ink"
      >
        {open ? "× DEV" : "⚙ DEV PANEL"}
      </button>
      {open && (
        <div className="rise fixed bottom-16 right-5 z-40 w-[320px] rounded-2xl border border-line-strong bg-surface/95 p-4 shadow-2xl backdrop-blur">
          <div className="label mb-1">Simulator · mock data only</div>
          <p className="mb-3 text-[11px] text-ink-3">Эти действия меняют только симулятор. KitShop не затрагивается.</p>
          <div className="grid grid-cols-2 gap-2">
            {ACTIONS.map((a) => (
              <button
                key={a.id}
                title={a.hint}
                disabled={dev.isPending}
                onClick={() => {
                  if (a.tone === "danger" && !confirm(`${a.label}: ${a.hint}?`)) return;
                  dev.mutate(a.id);
                }}
                className={clsx(
                  "rounded-lg border px-2 py-2 text-left font-mono text-[10.5px] font-semibold tracking-wide transition disabled:opacity-40",
                  a.tone === "danger" ? "border-crit/30 text-crit-ink hover:bg-crit/10" : "border-line-strong text-ink-2 hover:bg-surface-3 hover:text-ink",
                )}
              >
                {a.label}
              </button>
            ))}
          </div>
          <div className="mt-3 max-h-40 space-y-1 overflow-auto border-t border-line pt-3">
            {dev.isPending && <div className="text-[11px] text-ink-3">Выполняю…</div>}
            {dev.error && <div className="text-[11px] text-crit-ink">{(dev.error as Error).message}</div>}
            {dev.data?.log.map((l, i) => (
              <div key={i} className="flex gap-2 text-[11px]">
                <span className="num font-mono text-ink-3">{fmtClock(l.at)}</span>
                <span className="text-ink-2">{l.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
