"use client";

import { useEffect, useState } from "react";
import { wallClockNow } from "@/lib/time";
import { fmtClock } from "@/lib/client/format";

const TZ = "Asia/Almaty";
const SYNC_WINDOW_MS = 16 * 60_000;

/**
 * Header clock. Shows the REAL current time (minute-accurate, ticking) while the data is live;
 * if the simulator was moved ahead with DEV buttons, shows the simulated time with a "SIM" mark instead.
 */
export function LiveClock({ serverNow, className }: { serverNow: number; className?: string }) {
  const [wall, setWall] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setWall(wallClockNow(TZ));
    tick();
    const t = setInterval(tick, 15_000);
    return () => clearInterval(t);
  }, []);
  const live = wall !== null && Math.abs(wall - serverNow) < SYNC_WINDOW_MS;
  return (
    <span className={className} title={live ? "Текущее время" : "Время симулятора (прокручено DEV-кнопками)"}>
      {live ? fmtClock(wall) : fmtClock(serverNow)}
      {!live && wall !== null && <span className="ml-1 rounded bg-warn/15 px-1 text-[10px] font-semibold text-warn">SIM</span>}
    </span>
  );
}
