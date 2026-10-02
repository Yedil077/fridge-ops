"use client";

import clsx from "clsx";
import { useMe } from "@/lib/client/api";

/** Always visible: where the numbers on screen come from. SIMULATOR is never presented as KiT Shop data. */
export function DataSourceBadge({ className }: { className?: string }) {
  const src = useMe().data?.dataSource;
  if (!src) return null;
  return (
    <span
      title="Источник данных на экране"
      className={clsx(
        "whitespace-nowrap rounded px-1.5 py-px text-[10px] font-bold tracking-wider",
        src === "KITSHOP REAL" ? "bg-good/20 text-good-ink" : src === "CACHE" ? "bg-warn/20 text-warn" : "bg-accent/15 text-accent",
        className,
      )}
    >
      DATA SOURCE: {src}
    </span>
  );
}
