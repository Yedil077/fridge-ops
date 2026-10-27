"use client";

import { useState } from "react";
import clsx from "clsx";
import { MobileShell } from "@/components/mobile/MobileShell";
import { SkeletonList } from "@/components/mobile/ui";
import { FridgeProfileCard } from "@/components/FridgeProfileCard";
import { useProfiles } from "@/lib/client/api";

/** Аналитика на телефоне: профиль каждой точки — норма, сегодня относительно нормы, что нужно и что можно отдать. */
export default function MobileAnalyticsPage() {
  const { data, error } = useProfiles();
  const [group, setGroup] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  if (error) return <MobileShell title="Аналитика"><p className="mt-10 text-center text-[15px] text-ink-2">{(error as Error).message}</p></MobileShell>;
  if (!data) return <MobileShell title="Аналитика"><SkeletonList /></MobileShell>;
  const g = data.groups.find((x) => x.name === group) ?? null;
  const shown = g ? data.profiles.filter((p) => g.fridgeIds.includes(p.id)) : data.profiles;
  // what needs attention first: anomalies and shortages
  const order = { ANOMALY: 0, ABOVE: 1, BELOW: 2, NORMAL: 3, QUIET: 4, NO_DATA: 5 } as const;
  const sorted = [...shown].sort(
    (a, b) => Number(b.summary.some((s) => s.startsWith("Нужно"))) - Number(a.summary.some((s) => s.startsWith("Нужно"))) || order[a.today.status] - order[b.today.status],
  );
  return (
    <MobileShell title="Аналитика" now={data.now}>
      <div className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1">
        <Chip on={!g} onClick={() => setGroup(null)}>Все</Chip>
        {data.groups.map((x) => (
          <Chip key={x.name} on={g?.name === x.name} onClick={() => setGroup(x.name)}>
            {x.name}
          </Chip>
        ))}
      </div>

      {g && g.transfers.length > 0 && (
        <section className="card mb-3 p-4">
          <div className="label mb-2">Что делать в {g.name}</div>
          {g.transfers.flatMap((t) =>
            t.lines.map((l, i) => (
              <div key={`${t.id}-${i}`} className="mb-2 last:mb-0">
                <div className="text-[15px] font-bold">
                  {t.from} → {l.to}
                </div>
                <div className="text-[13px]">
                  {l.category} ×{l.qty}: {l.items.join(", ")}
                </div>
                <div className="text-[12px] text-ink-3">{l.why.join(" · ")}</div>
              </div>
            )),
          )}
        </section>
      )}

      <div className="space-y-3">
        {sorted.map((p) => (
          <div key={p.id} onClick={() => setOpen(open === p.id ? null : p.id)}>
            <FridgeProfileCard p={p} compact={open !== p.id} />
          </div>
        ))}
      </div>
      <p className="mt-4 px-1 text-[12px] text-ink-3">Нажмите на точку — подробный профиль: категории, любимые блюда, дни недели.</p>
    </MobileShell>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={clsx("h-10 shrink-0 rounded-xl px-4 text-[14px] font-semibold", on ? "bg-ink text-bg" : "bg-surface-2 text-ink-2")}>
      {children}
    </button>
  );
}
