"use client";

import { useState } from "react";
import clsx from "clsx";
import type { Mission } from "@/lib/domain/types";
import { categoryById } from "@/lib/domain/categories";
import { useMissionAction, type XpGain } from "@/lib/client/api";
import { fmtClock } from "@/lib/client/format";

const TYPE_STYLE: Record<Mission["type"], string> = {
  URGENT: "text-crit-ink bg-crit/12 border-crit/30",
  RESCUE: "text-serious bg-serious/10 border-serious/30",
  REBALANCE: "text-accent bg-accent/10 border-accent/25",
};

const PRIORITY_STYLE: Record<Mission["priorityLabel"], string> = {
  CRITICAL: "text-crit-ink",
  HIGH: "text-serious",
  MEDIUM: "text-warn",
  LOW: "text-ink-2",
};

const STATUS_LABEL: Record<Mission["status"], string> = {
  NEW: "Новая",
  ACCEPTED: "Принята",
  IN_PROGRESS: "В пути",
  COMPLETED: "Выполнена",
  SKIPPED: "Пропущена",
  EXPIRED: "Устарела",
};

const nameOf = (m: Mission, id: string) => (id === m.sourceFridgeId ? m.sourceName : m.stopNames?.[id]) ?? id;

export function MissionCard({ mission: m, onXp, compact }: { mission: Mission; onXp?: (xp: XpGain[]) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const action = useMissionAction(onXp);
  const busy = action.isPending;
  const active = m.status === "NEW" || m.status === "ACCEPTED" || m.status === "IN_PROGRESS";

  return (
    <article className={clsx("card rise overflow-hidden", m.status === "IN_PROGRESS" && "border-accent/40")}>
      <div className="p-4">
        <div className="flex items-center gap-2">
          <span className={clsx("rounded-md border px-2 py-0.5 text-[10px] font-bold tracking-[0.12em]", TYPE_STYLE[m.type])}>{m.title}</span>
          <span className="text-[11px] text-ink-3">MISSION #{m.number}</span>
          {m.status !== "NEW" && <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-ink-2">{STATUS_LABEL[m.status]}</span>}
          <div className="ml-auto text-right leading-none">
            <span className={clsx("num text-[22px] font-semibold", PRIORITY_STYLE[m.priorityLabel])}>{m.priority}</span>
            <span className="ml-1 text-[10px] text-ink-3">/100</span>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
          <span className="rounded-lg border border-line-strong bg-surface-2 px-2.5 py-1.5 font-semibold">📍 {nameOf(m, m.sourceFridgeId)}</span>
          {m.stops.map((s) => (
            <span key={s.targetFridgeId} className="flex items-center gap-2">
              <span className="text-ink-3">→</span>
              <span className="rounded-lg border border-line-strong bg-surface-2 px-2.5 py-1.5">{nameOf(m, s.targetFridgeId)}</span>
            </span>
          ))}
        </div>
        <div className="mt-3 space-y-2">
          {m.stops.map((s) => (
            <div key={s.targetFridgeId}>
              {m.stops.length > 1 && <div className="mb-1 text-[11px] text-ink-3">Для {nameOf(m, s.targetFridgeId)}:</div>}
              {m.lines
                .filter((l) => l.targetFridgeId === s.targetFridgeId)
                .flatMap((l) =>
                  l.products.map((p) => (
                    <div key={l.categoryId + p.productId} className="flex items-baseline gap-2 text-[13px]">
                      <span>{categoryById(l.categoryId).emoji}</span>
                      <span className="text-ink">{p.name}</span>
                      <span className="num ml-auto font-semibold">×{p.actualQty ?? p.qty}</span>
                    </div>
                  )),
                )}
            </div>
          ))}
        </div>

        <p className="mt-3 text-[13px] text-ink">{m.headline}</p>
        {!compact && m.effect.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-3">
            {m.effect.map((e) => (
              <span key={e.label}>
                {e.label}: <span className="num text-good-ink">{e.value}</span>
              </span>
            ))}
            <span>В пути ~{m.travelMinutes} мин</span>
          </div>
        )}

        {m.evaluation && (
          <div className="mt-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[12px]">
            <span className={clsx("font-semibold", m.evaluation.result === "EXCELLENT" || m.evaluation.result === "GOOD" ? "text-good-ink" : "text-warn")}>
              {m.evaluation.result}
            </span>
            <span className="text-ink-3">
              {" "}· продано {m.evaluation.lines.reduce((a, l) => a + l.soldAttributed, 0)} из {m.evaluation.lines.reduce((a, l) => a + l.moved, 0)} · точность прогноза{" "}
              {Math.round(m.evaluation.accuracy * 100)}%
            </span>
          </div>
        )}

        {active && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {m.status === "NEW" && (
              <button
                disabled={busy}
                onClick={() => action.mutate({ id: m.id, body: { action: "accept" } })}
                className="rounded-lg bg-ink px-4 py-2 text-[13px] font-semibold text-bg transition hover:bg-white disabled:opacity-50"
              >
                Принять миссию
              </button>
            )}
            {m.status === "ACCEPTED" && (
              <button
                disabled={busy}
                onClick={() => action.mutate({ id: m.id, body: { action: "start" } })}
                className="rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink hover:bg-surface-3 disabled:opacity-50"
              >
                Везу
              </button>
            )}
            {(m.status === "ACCEPTED" || m.status === "IN_PROGRESS") && (
              <button
                disabled={busy}
                onClick={() => action.mutate({ id: m.id, body: { action: "complete" } })}
                className="rounded-lg bg-good px-4 py-2 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
              >
                ✓ Выполнено
              </button>
            )}
            <button onClick={() => setOpen(!open)} className="rounded-lg px-3 py-2 text-[13px] text-ink-2 hover:text-ink">
              {open ? "Скрыть" : "Почему?"}
            </button>
            <button
              disabled={busy}
              onClick={() => action.mutate({ id: m.id, body: { action: "skip" } })}
              className="ml-auto rounded-lg px-2 py-2 text-[12px] text-ink-3 hover:text-ink disabled:opacity-50"
            >
              Пропустить
            </button>
          </div>
        )}
        {!active && !compact && (
          <button onClick={() => setOpen(!open)} className="mt-3 text-[12px] text-ink-3 hover:text-ink">
            {open ? "Скрыть объяснение" : "Показать объяснение"}
          </button>
        )}
        {action.error && <p className="mt-2 text-[12px] text-crit-ink">{(action.error as Error).message}</p>}
        {m.acceptedBy && (
          <p className="mt-2 text-[11px] text-ink-3">
            {m.acceptedBy} · принято {m.acceptedAt ? fmtClock(m.acceptedAt) : ""}
            {m.completedAt ? ` · выполнено ${fmtClock(m.completedAt)}` : ""}
            {m.xpAwarded ? ` · +${m.xpAwarded} XP` : ""}
          </p>
        )}
      </div>

      {open && (
        <div className="border-t border-line bg-surface-2/60 p-4">
          {m.lines.map((l) => {
            const cat = categoryById(l.categoryId);
            return (
              <div key={l.categoryId + l.targetFridgeId} className="mb-4 last:mb-0">
                <div className="mb-2 text-[13px] font-semibold">
                  {cat.emoji} {l.recommendedQty} · {cat.name.toLowerCase()} → {nameOf(m, l.targetFridgeId)}
                  <span className="ml-2 font-normal text-ink-3">диапазон {l.qtyRange[0]}–{l.qtyRange[1]}</span>
                </div>
                <p className="mb-3 text-[13px] text-ink-2">{l.why.summary}</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <WhyBlock title={`Куда · ${nameOf(m, l.targetFridgeId)}`} lines={l.why.target} />
                  <WhyBlock title={`Откуда · ${nameOf(m, m.sourceFridgeId)}`} lines={l.why.source} />
                  <WhyBlock title="Решение" lines={l.why.decision} />
                </div>

              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

function WhyBlock({ title, lines }: { title: string; lines: { label: string; value: string; emphasis?: boolean }[] }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="label mb-2">{title}</div>
      <dl className="space-y-1.5">
        {lines.map((x) => (
          <div key={x.label} className="flex items-baseline justify-between gap-3 text-[12px]">
            <dt className="text-ink-3">{x.label}</dt>
            <dd className={clsx("num text-right", x.emphasis ? "font-semibold text-ink" : "text-ink-2")}>{x.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
