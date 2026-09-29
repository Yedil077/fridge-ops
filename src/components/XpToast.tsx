"use client";

import { useCallback, useState } from "react";
import type { XpGain } from "@/lib/client/api";

interface Toast {
  id: number;
  gains: XpGain[];
}

/** Restrained "mission complete" feedback: one small toast, auto-dismissed. */
export function useXpToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((gains: XpGain[]) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, gains }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2900);
  }, []);
  const view = (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="toast rounded-xl border border-line-strong bg-surface-2/95 px-5 py-3 shadow-2xl backdrop-blur">
          <div className="flex items-center gap-3">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-good/20 text-good-ink">✓</span>
            <div>
              <div className="text-[13px] font-semibold">{t.gains[0]?.reason}</div>
              {t.gains.slice(1).map((g) => (
                <div key={g.reason} className="text-[11px] text-ink-3">
                  {g.reason} <span className="text-xp">+{g.amount}</span>
                </div>
              ))}
            </div>
            <span className="num ml-3 text-[18px] font-semibold text-xp">+{t.gains.reduce((a, g) => a + g.amount, 0)} XP</span>
          </div>
        </div>
      ))}
    </div>
  );
  return { push, view };
}
