"use client";

import { useState } from "react";
import clsx from "clsx";
import { Shell } from "@/components/Shell";
import { FridgeProfileCard, StatusBadge } from "@/components/FridgeProfileCard";
import { useProfiles, type ProfilesView } from "@/lib/client/api";

/**
 * Аналитика = профили холодильников. 180 дней каждой точки → её собственная норма, характер и вывод на сегодня.
 * Группа (SATTI, KABLAN_KANKORD…) → сравнение точек и переносы с объяснением.
 */
export default function AnalyticsPage() {
  const { data, error } = useProfiles();
  const [group, setGroup] = useState<string | null>(null);

  if (error) return <Shell><p className="p-6 text-crit-ink">{(error as Error).message}</p></Shell>;
  if (!data) return <Shell><p className="p-6 text-ink-3">Считаю профили по истории…</p></Shell>;

  const g = data.groups.find((x) => x.name === group) ?? null;
  const shown = g ? data.profiles.filter((p) => g.fridgeIds.includes(p.id)) : data.profiles;

  return (
    <Shell now={data.now}>
      <div className="mb-4">
        <h1 className="text-[22px] font-bold">Профили холодильников</h1>
        <p className="text-[13px] text-ink-3">
          Норма каждой точки посчитана по её собственным продажам за 180 дней (те же дни недели, те же часы, свежие недели важнее). «Сегодня» —
          относительно её нормы, а не средней по сети.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <Chip on={!g} onClick={() => setGroup(null)}>Все точки</Chip>
        {data.groups.map((x) => (
          <Chip key={x.name} on={g?.name === x.name} onClick={() => setGroup(x.name)}>
            {x.name} · {x.fridgeIds.length}
          </Chip>
        ))}
      </div>

      {g && <GroupView g={g} profiles={shown} />}

      <div className={clsx("grid gap-3", g ? "mt-6 lg:grid-cols-2 2xl:grid-cols-3" : "lg:grid-cols-2 2xl:grid-cols-3")}>
        {shown.map((p) => (
          <FridgeProfileCard key={p.id} p={p} />
        ))}
      </div>
    </Shell>
  );
}

function GroupView({ g, profiles }: { g: ProfilesView["groups"][number]; profiles: ProfilesView["profiles"] }) {
  const cats = profiles[0]?.categories ?? [];
  const row = (label: string, cell: (p: ProfilesView["profiles"][number]) => React.ReactNode) => (
    <tr key={label} className="border-t border-line">
      <td className="py-1.5 text-ink-3">{label}</td>
      {profiles.map((p) => (
        <td key={p.id} className="num">
          {cell(p)}
        </td>
      ))}
    </tr>
  );
  return (
    <div className="space-y-4">
      <section className="card p-4">
        <h2 className="label mb-2">Что делать сейчас в группе {g.name}</h2>
        {g.transfers.length === 0 ? (
          <p className="text-[13px] text-ink-3">Сейчас переносы внутри группы не нужны: у тех, кому может не хватить, нет безопасного источника, или всем хватает.</p>
        ) : (
          <div className="space-y-3">
            {g.transfers.map((t) =>
              t.lines.map((l, i) => (
                <div key={`${t.id}-${i}`} className="rounded-lg border border-line p-3">
                  <div className="text-[15px] font-bold">
                    {t.from} → {l.to}: {l.category} ×{l.qty}
                  </div>
                  <div className="text-[13px] text-ink-2">{l.items.join(", ")}</div>
                  <ul className="mt-1 text-[12px] text-ink-3">
                    {l.why.map((w) => (
                      <li key={w}>· {w}</li>
                    ))}
                  </ul>
                </div>
              )),
            )}
          </div>
        )}
      </section>

      <section className="card overflow-x-auto p-4">
        <h2 className="label mb-2">Сравнение</h2>
        <table className="w-full min-w-[640px] text-[13px] [&_td]:px-2 [&_th]:px-2">
          <thead className="text-left">
            <tr>
              <th />
              {profiles.map((p) => (
                <th key={p.id} className="py-1">
                  <div className="font-bold">{p.name}</div>
                  <StatusBadge p={p} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row("Продаж в день (норма)", (p) => `${p.normalDay.low}–${p.normalDay.high}`)}
            {row("Сегодня / обычно к этому часу", (p) => `${p.today.sales} / ${p.normalByNow.low}–${p.normalByNow.high}`)}
            {row("Темп дня", (p) => (p.today.deviationPct === null ? "—" : `${p.today.deviationPct > 0 ? "+" : ""}${p.today.deviationPct}%`))}
            {cats.map((c) =>
              row(`${c.emoji} ${c.name}: спрос / есть`, (p) => {
                const x = p.categories.find((y) => y.id === c.id)!;
                return (
                  <span className={x.status === "LOW" ? "text-crit-ink" : x.status === "SURPLUS" ? "text-good-ink" : ""}>
                    {x.index.toFixed(2)}× / {x.stock}
                    {x.status === "LOW" ? ` (+${x.need})` : x.status === "SURPLUS" ? ` (отдать ${x.canGive})` : ""}
                  </span>
                );
              }),
            )}
            {row("Пик", (p) => p.peaks.join(", ") || "—")}
            {row("Сильный день", (p) => p.strongWeekdays.join(", ") || "ровно")}
            {row("Остаток", (p) => p.stock)}
            {row("Уверенность", (p) => `${Math.round(p.confidence * 100)}%`)}
          </tbody>
        </table>
      </section>

      {g.dishes.length > 0 && (
        <section className="card overflow-x-auto p-4">
          <h2 className="label mb-2">Где какое блюдо продаётся лучше (1.00 = средний уровень сети)</h2>
          <table className="w-full min-w-[640px] text-[13px] [&_td]:px-2 [&_th]:px-2">
            <thead className="text-left text-ink-3">
              <tr>
                <th className="py-1">Блюдо</th>
                {profiles.map((p) => (
                  <th key={p.id}>{p.name}</th>
                ))}
                <th>Лучшее место</th>
              </tr>
            </thead>
            <tbody>
              {g.dishes.map((d) => (
                <tr key={d.name} className="border-t border-line">
                  <td className="py-1.5">{d.name}</td>
                  {d.affinity.map((v, i) => (
                    <td key={i} className={clsx("num", v >= 1.25 ? "text-good-ink font-semibold" : v <= 0.75 ? "text-ink-3" : "")}>
                      {v.toFixed(2)}
                    </td>
                  ))}
                  <td>{d.best}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={clsx("h-9 rounded-lg px-3 text-[13px] font-semibold", on ? "bg-ink text-bg" : "bg-surface-2 text-ink-2 hover:text-ink")}>
      {children}
    </button>
  );
}
