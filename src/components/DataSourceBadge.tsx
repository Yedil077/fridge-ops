"use client";

import clsx from "clsx";
import { useMe } from "@/lib/client/api";

/** Always visible: where the numbers on screen come from. SIMULATOR is never presented as KiT Shop data. */
export function DataSourceBadge({ className }: { className?: string }) {
  const me = useMe().data;
  const src = me?.dataSource;
  if (!src) return null;
  const at = me?.lastSyncAt ? new Date(me.lastSyncAt) : null;
  const hm = at ? `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}` : null;
  return (
    <span
      title={hm ? `Источник данных на экране · последняя синхронизация с KiT Shop ${hm}` : "Источник данных на экране"}
      className={clsx(
        "whitespace-nowrap rounded px-1.5 py-px text-[10px] font-bold tracking-wider",
        src === "KITSHOP REAL" ? "bg-good/20 text-good-ink" : src === "CACHE" ? "bg-warn/20 text-warn" : "bg-accent/15 text-accent",
        className,
      )}
    >
      DATA SOURCE: {src === "LOADING" ? "KITSHOP · ЗАГРУЗКА" : src}
      {src === "CACHE" && hm ? ` · ${hm}` : ""}
    </span>
  );
}
