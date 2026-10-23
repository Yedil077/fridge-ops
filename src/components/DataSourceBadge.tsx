"use client";

import clsx from "clsx";
import { useMe } from "@/lib/client/api";

/** Data older than this is shown as stale on every screen. */
const STALE_MS = 15 * 60_000;

/**
 * Always visible on every screen: «Последнее обновление: HH:MM» from KiT Shop, «⚠ Данные устарели» when the last
 * successful sync is older than 15 minutes, «ДАННЫЕ НЕДОСТУПНЫ» / «Данные загружаются» when there is nothing yet.
 * SIMULATOR is never presented as KiT Shop data.
 */
export function DataSourceBadge({ className }: { className?: string }) {
  const me = useMe().data;
  const src = me?.dataSource;
  if (!src) return null;
  // server wall-clock values are Almaty time ("UTC fields = local"); compare with the server time of the same kind
  const at = me?.lastSyncAt ?? null;
  const hm = at ? `${String(new Date(at).getUTCHours()).padStart(2, "0")}:${String(new Date(at).getUTCMinutes()).padStart(2, "0")}` : null;
  const stale = src === "CACHE" || (at !== null && me?.serverNow !== undefined && me.serverNow - at > STALE_MS);
  const text =
    src === "SIMULATOR"
      ? "SIMULATOR · не реальные данные"
      : src === "LOADING"
        ? "Данные KiT Shop загружаются"
        : src === "UNAVAILABLE"
          ? "ДАННЫЕ НЕДОСТУПНЫ"
          : stale
            ? `⚠ Данные устарели · обновлено ${hm ?? "—"}`
            : `Последнее обновление: ${hm ?? "—"}`;
  return (
    <span
      title="Когда Apps Холодосов последний раз получил остатки и продажи из KiT Shop"
      className={clsx(
        "whitespace-nowrap rounded px-1.5 py-px text-[11px] font-semibold",
        src === "SIMULATOR" ? "bg-accent/15 text-accent" : src === "UNAVAILABLE" ? "bg-crit/20 text-crit-ink" : stale || src === "LOADING" ? "bg-warn/20 text-warn" : "bg-good/15 text-good-ink",
        className,
      )}
    >
      {text}
    </span>
  );
}
