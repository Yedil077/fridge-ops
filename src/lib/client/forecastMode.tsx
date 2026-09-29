"use client";

import { useCallback, useSyncExternalStore } from "react";
import clsx from "clsx";
import type { ForecastMode } from "@/lib/domain/types";

/**
 * Forecast horizon chosen by the user — REAL TIME (until the next check) or ДО 20:00.
 * Remembered on this device and sent to the server (?mode=…), where it really changes the engine.
 */

const KEY = "fo-forecast-mode";
const EVENT = "fo-forecast-mode";

function read(): ForecastMode {
  try {
    return localStorage.getItem(KEY) === "until20" ? "until20" : "realtime";
  } catch {
    return "realtime";
  }
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

export function useForecastMode(): [ForecastMode, (m: ForecastMode) => void] {
  const mode = useSyncExternalStore(subscribe, read, () => "realtime" as ForecastMode);
  const set = useCallback((m: ForecastMode) => {
    try {
      localStorage.setItem(KEY, m);
    } catch {
      /* storage unavailable — mode lives only in this page */
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [mode, set];
}

export function ModeToggle({ size = "md", className }: { size?: "sm" | "md"; className?: string }) {
  const [mode, setMode] = useForecastMode();
  const btn = (m: ForecastMode, label: string, hint: string) => (
    <button
      key={m}
      type="button"
      onClick={() => setMode(m)}
      title={hint}
      aria-pressed={mode === m}
      className={clsx(
        "flex-1 whitespace-nowrap rounded-lg font-semibold tracking-wide transition",
        size === "md" ? "h-11 px-3 text-[14px]" : "h-8 px-2.5 text-[12px]",
        mode === m ? "bg-ink text-bg" : "text-ink-3 hover:text-ink",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className={clsx("flex gap-1 rounded-xl border border-line bg-surface p-1", className)} role="group" aria-label="Горизонт прогноза">
      {btn("realtime", "REAL TIME", "Что сделать сейчас, до следующей проверки (~90 мин)")}
      {btn("until20", "ДО 20:00", "Распределить с учётом спроса до 20:00")}
    </div>
  );
}
