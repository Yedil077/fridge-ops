"use client";

import Link from "next/link";
import clsx from "clsx";
import { MobileShell } from "@/components/mobile/MobileShell";
import { SkeletonList } from "@/components/mobile/ui";
import { useMobileFridges } from "@/lib/client/mobileApi";

const DOT = { critical: "🔴", attention: "🟡", normal: "🟢", closed: "⚪" } as const;

export default function MobileFridgesPage() {
  const { data } = useMobileFridges();
  if (!data) return <MobileShell title="Холодильники"><SkeletonList /></MobileShell>;
  return (
    <MobileShell title="Холодильники" now={data.now}>
      <div className="space-y-2">
        {data.fridges.map((f) => (
          <Link
            key={f.id}
            href={`/m/fridges/${f.id}`}
            className={clsx("card flex min-h-[64px] items-center gap-3 px-4 py-3 active:bg-surface-2", f.status === "critical" && "border-crit/50", f.status === "closed" && "opacity-60")}
          >
            <span className="text-[16px]">{DOT[f.status]}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[17px] font-semibold">{f.name}</div>
              <div className="truncate text-[13px] text-ink-3">{f.note}</div>
            </div>
            <div className="text-right">
              <div className="num text-[18px] font-bold">{f.totalStock}</div>
              <div className="text-[11px] text-ink-3">в наличии</div>
            </div>
            <span className="text-[22px] text-ink-3">›</span>
          </Link>
        ))}
      </div>
    </MobileShell>
  );
}
