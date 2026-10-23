"use client";

import { useCallback, useSyncExternalStore } from "react";
import clsx from "clsx";
import { FORECAST_MODE_IDS, type ForecastMode } from "@/lib/domain/types";
import { useMe } from "./api";

/**
 * Forecast horizon chosen by the user — always from NOW, any time of day (windows cross midnight):
 * СЕЙЧАС (about the next hour) · ДО ВЕЧЕРА (until the time from Настройки, default 20:00).
 * Remembered on this device and sent to the server (?mode=…), where it really changes the engine.
 */

const KEY = "fo-forecast-mode";
const EVENT = "fo-forecast-mode";

function read(): ForecastMode {
  try {
    const v = localStorage.getItem(KEY) as ForecastMode | null;
    return v && FORECAST_MODE_IDS.includes(v) ? v : "realtime";
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
  const me = useMe().data;
  const until = me?.untilTime ?? me?.closeTime ?? "20:00";
  const passed = !!me?.untilPassed;
  const btn = (m: ForecastMode, label: string, hint: string, disabled = false) => (
    <button
      key={m}
      type="button"
      onClick={() => !disabled && setMode(m)}
      title={hint}
      aria-pressed={mode === m}
      aria-disabled={disabled}
      className={clsx(
        "shrink-0 grow whitespace-nowrap rounded-lg font-semibold tracking-wide transition",
        size === "md" ? "h-11 px-3 text-[13px]" : "h-8 px-2.5 text-[12px]",
        mode === m ? "bg-ink text-bg" : disabled ? "text-ink-3/40 line-through" : "text-ink-3 hover:text-ink",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className={className}>
      <div className="flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="group" aria-label="Горизонт прогноза">
        {btn("realtime", "СЕЙЧАС", "Что сделать сейчас: примерно ближайший час")}
        {btn("until20", `ДО ВЕЧЕРА · ${until}`, passed ? `${until} уже прошло — режим недоступен до завтра` : `Как распределить еду до ${until} (время меняется в Настройках)`, passed)}
      </div>
      {mode === "until20" && passed && (
        <p className="mt-1 px-1 text-[12px] text-warn">{until} уже прошло — режим «ДО ВЕЧЕРА» закончился, показан режим «СЕЙЧАС».</p>
      )}
    </div>
  );
}
