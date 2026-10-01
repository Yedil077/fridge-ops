"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useQueryClient } from "@tanstack/react-query";
import { MobileShell } from "@/components/mobile/MobileShell";
import { DishRow, SkeletonList, UrgencyPill, plural } from "@/components/mobile/ui";
import { MissionKitShopStatus } from "@/components/mobile/ops";
import { useMobileTask, type MobileRoute } from "@/lib/client/mobileApi";
import type { CompletionImpact, MissionActionResult, XpGain } from "@/lib/client/api";
import { clearProgress, loadProgress, saveProgress, sendOrQueue, type RouteProgress } from "@/lib/client/offline";

/**
 * Route execution on the phone. Recommendations are a WISH, not an order:
 * the employee chooses how many of each dish to take (0…recommended), can skip any dish,
 * and continues with a partial choice. Only what was chosen is shown at the drop-off stops.
 */

interface PickItem {
  productId: string;
  name: string;
  sku: string;
  emoji: string;
  color: string;
  categoryName: string;
  planned: number;
}

const SKIP_REASONS: { id: string; label: string }[] = [
  { id: "no_stock", label: "Нет в наличии" },
  { id: "not_needed", label: "Не хочу переносить" },
  { id: "low_left", label: "Мало осталось" },
  { id: "other", label: "Другое" },
];

/** Same dish for several stops is picked once: aggregate by product. */
function pickList(r: MobileRoute): PickItem[] {
  const map = new Map<string, PickItem>();
  for (const s of r.stops)
    for (const i of s.items) {
      const cur = map.get(i.productId);
      if (cur) cur.planned += i.qty;
      else map.set(i.productId, { productId: i.productId, name: i.name, sku: i.sku, emoji: i.emoji, color: i.color, categoryName: i.categoryName, planned: i.qty });
    }
  return [...map.values()];
}

/** Splits the chosen quantity of each dish over the stops (earlier stops first). key = `${stop}:${line}:${product}` */
function distribute(r: MobileRoute, selected: Record<string, number>): Map<string, number> {
  const left = new Map<string, number>();
  for (const p of pickList(r)) left.set(p.productId, selected[p.productId] ?? 0);
  const out = new Map<string, number>();
  r.stops.forEach((s, si) =>
    s.items.forEach((i) => {
      const have = left.get(i.productId) ?? 0;
      const q = Math.min(have, i.qty);
      left.set(i.productId, have - q);
      out.set(`${si}:${i.lineIndex}:${i.productId}`, q);
    }),
  );
  return out;
}

const emptyProgress = (): RouteProgress => ({ phase: "pick", stopIndex: 0, selected: {}, skipped: {}, delivered: {}, updatedAt: Date.now() });

export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error } = useMobileTask(id);
  const qc = useQueryClient();
  const [progress, setProgress] = useState<RouteProgress | null>(null);
  const [details, setDetails] = useState(false);
  const [result, setResult] = useState<{ xp: XpGain[]; impact?: CompletionImpact; queued?: boolean; skipped?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setProgress(loadProgress(id));
  }, [id]);

  const update = (p: RouteProgress) => {
    setProgress(p);
    saveProgress(id, p);
  };

  if (error) return <MobileShell back="/m/tasks" title="Задача"><p className="mt-10 text-center text-ink-2">{(error as Error).message}</p></MobileShell>;
  if (!data) return <MobileShell back="/m/tasks" title="Задача"><SkeletonList /></MobileShell>;
  const r = data.route;

  if (result) return <Success r={r} result={result} />;

  const closed = r.status === "COMPLETED" || r.status === "SKIPPED" || r.status === "EXPIRED";

  async function start() {
    setErr(null);
    update(progress ?? emptyProgress());
    try {
      await sendOrQueue(`/api/missions/${r.id}`, "PATCH", { action: "start" });
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  /** Sends what really happened: chosen and delivered quantities per dish, optional skip reasons. */
  async function finish(p: RouteProgress) {
    setBusy(true);
    setErr(null);
    const dist = distribute(r, p.selected);
    const items = r.stops.flatMap((s, si) =>
      s.items.map((i) => {
        const key = `${si}:${i.lineIndex}:${i.productId}`;
        const selectedQty = dist.get(key) ?? 0;
        const qty = Math.min(selectedQty, p.delivered[key] ?? selectedQty);
        const reason = p.skipped[i.productId];
        return {
          lineIndex: i.lineIndex,
          productId: i.productId,
          qty,
          selectedQty,
          ...(qty === 0 ? { skipReason: SKIP_REASONS.some((x) => x.id === reason) ? reason : "skipped" } : {}),
        };
      }),
    );
    try {
      const res = await sendOrQueue<MissionActionResult>(`/api/missions/${r.id}`, "PATCH", { action: "complete", items });
      clearProgress(r.id);
      const moved = items.reduce((a, x) => a + x.qty, 0);
      if (res.queued) setResult({ xp: [], queued: true, skipped: moved === 0 });
      else setResult({ xp: res.data.xp, impact: res.data.impact, skipped: moved === 0 });
      qc.invalidateQueries();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (progress && progress.phase !== "done" && !closed)
    return <Execution r={r} p={progress} onChange={update} onFinish={finish} busy={busy} err={err} onPause={() => setProgress(null)} />;

  return (
    <MobileShell back="/m" title={`Задача #${r.number}`} now={data.now}>
      <div className="flex items-center justify-between">
        <UrgencyPill u={r.urgency} big />
        <span className="text-[13px] text-ink-3">приоритет {r.priority}/100</span>
      </div>

      <section className="card mt-4 p-5">
        <div className="label">Откуда</div>
        <div className="mt-1 text-[26px] font-bold">📍 {r.sourceName}</div>
        {r.sourceLocation && <div className="text-[14px] text-ink-3">{r.sourceLocation}</div>}
        <div className="label mt-4">Рекомендуем взять</div>
        <div className="mt-2 space-y-2">
          {pickList(r).map((p) => (
            <DishRow key={p.productId} name={p.name} sku={p.sku} emoji={p.emoji} color={p.color} categoryName={p.categoryName} qty={p.planned} />
          ))}
        </div>
        <div className="mt-2 text-[13px] text-ink-3">Можно взять меньше — выберете количество на следующем шаге.</div>
      </section>

      <section className="mt-4 space-y-3">
        {r.stops.map((s, si) => (
          <div key={s.fridgeId} className="card p-4">
            <div className="flex items-baseline justify-between">
              <div className="text-[13px] text-ink-3">{r.stops.length > 1 ? `${si + 1} → ` : ""}положи в</div>
              <div className="text-[13px] text-ink-3">~{s.travelMinutes} мин</div>
            </div>
            <div className="text-[22px] font-bold">{s.name}</div>
            <ul className="mt-2 space-y-1.5">
              {s.items.map((i) => (
                <li key={i.lineIndex + i.productId} className="flex items-baseline gap-2 text-[16px]">
                  <span>{i.emoji}</span>
                  <span className="flex-1">{i.name}</span>
                  <span className="num font-bold">×{i.actualQty ?? i.qty}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="card mt-4 p-4">
        <div className="label mb-2">Почему</div>
        <ul className="space-y-2 text-[15px] leading-snug text-ink">
          {r.why.map((w) => (
            <li key={w}>• {w}</li>
          ))}
        </ul>
        <button onClick={() => setDetails(!details)} className="mt-3 h-11 text-[15px] text-accent">
          {details ? "Скрыть подробности" : "Подробнее"}
        </button>
        {details && (
          <div className="mt-2 space-y-4">
            {r.details.map((d, i) => (
              <div key={i}>
                <div className="mb-1 text-[13px] font-semibold text-ink-2">
                  {d.category} → {d.stop}
                </div>
                <dl className="space-y-1">
                  {d.lines.map((x) => (
                    <div key={x.label} className="flex justify-between gap-3 text-[13px]">
                      <dt className="text-ink-3">{x.label}</dt>
                      <dd className="num text-right text-ink-2">{x.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        )}
      </section>

      {err && <p className="mt-3 text-[14px] text-crit-ink">{err}</p>}

      {!closed ? (
        <div className="sticky bottom-[calc(76px+env(safe-area-inset-bottom))] mt-5 space-y-2 bg-gradient-to-t from-bg via-bg pb-2 pt-3">
          <button onClick={start} className="h-16 w-full rounded-2xl bg-ink text-[18px] font-bold text-bg active:scale-[0.99]">
            {progress ? "ПРОДОЛЖИТЬ" : "НАЧАТЬ"}
          </button>
          {r.status === "NEW" && (
            <button
              onClick={async () => {
                if (!confirm("Пропустить эту задачу?")) return;
                await sendOrQueue(`/api/missions/${r.id}`, "PATCH", { action: "skip" }).catch(() => {});
                qc.invalidateQueries();
                window.location.href = "/m";
              }}
              className="h-12 w-full text-[15px] text-ink-3"
            >
              Пропустить задачу
            </button>
          )}
        </div>
      ) : (
        <div className="card mt-5 p-4 text-center text-[15px] text-ink-2">
          {r.status === "COMPLETED" ? "✓ Задача выполнена" : r.status === "SKIPPED" ? "Задача пропущена" : "Задача устарела — есть более свежий план"}
          {r.status === "COMPLETED" && <MissionKitShopStatus missionId={r.id} />}
          {r.evaluation && (
            <div className="mt-2 text-[14px]">
              Продано {r.evaluation.lines.reduce((a, l) => a + l.soldAttributed, 0)} из {r.evaluation.lines.reduce((a, l) => a + l.moved, 0)} · {r.evaluation.result}
            </div>
          )}
        </div>
      )}
    </MobileShell>
  );
}

// ───────────────────────── execution (pick → summary → drop) ─────────────────────────

function Stepper({ value, max, onChange }: { value: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(Math.max(0, value - 1))}
        disabled={value <= 0}
        className="h-12 w-12 rounded-xl bg-surface-3 text-[26px] leading-none disabled:opacity-30"
        aria-label="Меньше"
      >
        −
      </button>
      <span className="num w-10 text-center text-[26px] font-bold">{value}</span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        className="h-12 w-12 rounded-xl bg-surface-3 text-[26px] leading-none disabled:opacity-30"
        aria-label="Больше"
      >
        +
      </button>
    </div>
  );
}

function Execution({
  r,
  p,
  onChange,
  onFinish,
  onPause,
  busy,
  err,
}: {
  r: MobileRoute;
  p: RouteProgress;
  onChange: (p: RouteProgress) => void;
  onFinish: (p: RouteProgress) => void;
  onPause: () => void;
  busy: boolean;
  err: string | null;
}) {
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const picks = useMemo(() => pickList(r), [r]);
  const dist = useMemo(() => distribute(r, p.selected), [r, p.selected]);
  const plannedTotal = picks.reduce((a, x) => a + x.planned, 0);
  const selectedTotal = picks.reduce((a, x) => a + (p.selected[x.productId] ?? 0), 0);

  // stops that actually get something (unchosen dishes are not shown at drop-off)
  const stopItems = (si: number) =>
    r.stops[si].items.map((i) => ({ i, qty: dist.get(`${si}:${i.lineIndex}:${i.productId}`) ?? 0 })).filter((x) => x.qty > 0);
  const activeStops = r.stops.map((_, si) => si).filter((si) => stopItems(si).length > 0);
  const totalSteps = 2 + activeStops.length;
  const step = p.phase === "pick" ? 1 : p.phase === "summary" ? 2 : 3 + Math.max(0, activeStops.indexOf(p.stopIndex));

  const setQty = (productId: string, q: number) => {
    const skipped = { ...p.skipped };
    if (q > 0) delete skipped[productId];
    onChange({ ...p, selected: { ...p.selected, [productId]: q }, skipped });
  };
  const skip = (productId: string, reason = "skipped") =>
    onChange({ ...p, selected: { ...p.selected, [productId]: 0 }, skipped: { ...p.skipped, [productId]: reason } });

  let header: { title: string; place: string };
  let body: React.ReactNode;
  let bar: React.ReactNode;

  if (p.phase === "pick") {
    header = { title: "ЗАБЕРИ ИЗ", place: r.sourceName };
    body = (
      <>
        <button
          type="button"
          onClick={() => onChange({ ...p, selected: Object.fromEntries(picks.map((x) => [x.productId, x.planned])), skipped: {} })}
          className="mb-3 flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-line-strong bg-surface-2 text-[15px] font-semibold active:bg-surface-3"
        >
          ☑ ВЫБРАТЬ ВСЁ
        </button>
        <div className="space-y-3">
          {picks.map((x) => {
            const q = p.selected[x.productId] ?? 0;
            const skipped = p.skipped[x.productId];
            return (
              <div key={x.productId} className={clsx("rounded-2xl border p-3", skipped ? "border-line bg-surface opacity-60" : q > 0 ? "border-good/50 bg-good/5" : "border-line bg-surface")}>
                <div className="flex items-start gap-3">
                  <span className="mt-1 w-1.5 self-stretch rounded-full" style={{ background: x.color }} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="text-[18px] font-semibold leading-snug">{x.name}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
                      <span>
                        {x.emoji} {x.categoryName}
                      </span>
                      <span className="rounded bg-surface-3 px-1.5 py-px font-mono text-[12px] text-ink-2">{x.sku}</span>
                    </div>
                    <div className="mt-1 text-[14px] text-ink-2">
                      Рекомендовано: <span className="num font-bold text-ink">{x.planned}</span>
                    </div>
                  </div>
                </div>
                {skipped ? (
                  <div className="mt-3">
                    <div className="mb-2 text-[13px] text-ink-3">Пропущено. Причина — по желанию:</div>
                    <div className="flex flex-wrap gap-2">
                      {SKIP_REASONS.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => skip(x.productId, s.id)}
                          className={clsx("h-10 rounded-xl border px-3 text-[13px]", skipped === s.id ? "border-ink bg-surface-3 text-ink" : "border-line text-ink-3")}
                        >
                          {s.label}
                        </button>
                      ))}
                      <button type="button" onClick={() => setQty(x.productId, x.planned)} className="h-10 rounded-xl px-3 text-[13px] text-accent">
                        Вернуть
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Stepper value={q} max={x.planned} onChange={(v) => setQty(x.productId, v)} />
                    <div className="ml-auto flex gap-1.5">
                      <button type="button" onClick={() => setQty(x.productId, x.planned)} className="h-12 rounded-xl border border-line-strong px-3 text-[13px] font-semibold">
                        ВСЁ
                      </button>
                      {x.planned >= 2 && (
                        <button type="button" onClick={() => setQty(x.productId, Math.max(1, Math.floor(x.planned / 2)))} className="h-12 rounded-xl border border-line-strong px-3 text-[13px] font-semibold">
                          ½
                        </button>
                      )}
                      <button type="button" onClick={() => skip(x.productId)} className="h-12 rounded-xl border border-line px-3 text-[13px] text-ink-3">
                        ПРОПУСТИТЬ
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </>
    );
    bar = confirmEmpty ? (
      <div className="space-y-2">
        <div className="text-center text-[15px]">Вы ничего не выбрали.</div>
        <button
          disabled={busy}
          onClick={() => onFinish({ ...p, phase: "done", skipped: Object.fromEntries(picks.map((x) => [x.productId, p.skipped[x.productId] ?? "skipped"])) })}
          className="h-14 w-full rounded-2xl bg-surface-3 text-[16px] font-semibold"
        >
          ПРОПУСТИТЬ ЭТУ ТОЧКУ
        </button>
        <button onClick={() => setConfirmEmpty(false)} className="h-11 w-full text-[14px] text-ink-3">
          Назад к выбору
        </button>
      </div>
    ) : (
      <div className="space-y-2">
        <div className="flex items-center justify-between text-[15px]">
          <span>
            Выбрано: <span className="num font-bold">{selectedTotal}</span> <span className="text-ink-3">из {plannedTotal}</span>
          </span>
          {selectedTotal > 0 && selectedTotal < plannedTotal && (
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...p,
                  phase: "summary",
                  skipped: { ...Object.fromEntries(picks.filter((x) => !(p.selected[x.productId] > 0)).map((x) => [x.productId, p.skipped[x.productId] ?? "skipped"])), ...p.skipped },
                })
              }
              className="h-10 rounded-xl px-2 text-[13px] text-ink-3"
            >
              Пропустить невыбранное
            </button>
          )}
        </div>
        <button
          onClick={() => (selectedTotal === 0 ? setConfirmEmpty(true) : onChange({ ...p, phase: "summary" }))}
          className={clsx("h-16 w-full rounded-2xl text-[18px] font-bold active:scale-[0.99]", selectedTotal > 0 ? "bg-good text-white" : "bg-surface-3 text-ink")}
        >
          ДАЛЬШЕ
        </button>
      </div>
    );
  } else if (p.phase === "summary") {
    header = { title: "ВЫ БЕРЁТЕ ИЗ", place: r.sourceName };
    body = (
      <div className="card p-4">
        <ul className="space-y-2">
          {picks
            .filter((x) => (p.selected[x.productId] ?? 0) > 0)
            .map((x) => (
              <li key={x.productId} className="flex items-baseline gap-2 text-[17px]">
                <span>{x.emoji}</span>
                <span className="flex-1">{x.name}</span>
                <span className="num font-bold">×{p.selected[x.productId]}</span>
              </li>
            ))}
        </ul>
        <div className="mt-3 border-t border-line pt-3 text-[16px]">
          Итого: <span className="num font-bold">{selectedTotal}</span> {plural(selectedTotal, "блюдо", "блюда", "блюд")}
          {selectedTotal < plannedTotal && <span className="text-ink-3"> · выбрано {selectedTotal} из {plannedTotal} рекомендованных</span>}
        </div>
      </div>
    );
    bar = (
      <div className="grid grid-cols-[1fr_2fr] gap-2">
        <button onClick={() => onChange({ ...p, phase: "pick" })} className="h-16 rounded-2xl border border-line-strong text-[16px] font-semibold">
          ИЗМЕНИТЬ
        </button>
        <button
          onClick={() => onChange({ ...p, phase: "drop", stopIndex: activeStops[0] ?? 0 })}
          className="h-16 rounded-2xl bg-good text-[18px] font-bold text-white active:scale-[0.99]"
        >
          ПРОДОЛЖИТЬ
        </button>
      </div>
    );
  } else {
    const si = p.stopIndex;
    const items = stopItems(si);
    const pos = activeStops.indexOf(si);
    const nextStop = activeStops[pos + 1];
    header = { title: "ПОЛОЖИ В", place: r.stops[si]?.name ?? "" };
    const deliveredHere = items.reduce((a, { i, qty }) => a + Math.min(qty, p.delivered[`${si}:${i.lineIndex}:${i.productId}`] ?? qty), 0);
    body = (
      <div className="space-y-3">
        {items.map(({ i, qty }) => {
          const key = `${si}:${i.lineIndex}:${i.productId}`;
          const d = Math.min(qty, p.delivered[key] ?? qty);
          return (
            <div key={key} className="rounded-2xl border border-line bg-surface p-3">
              <DishRow name={i.name} sku={i.sku} emoji={i.emoji} color={i.color} categoryName={i.categoryName} qty={qty} hint={i.hint} />
              {qty > 1 && (
                <div className="mt-2 flex items-center justify-between px-1">
                  <span className="text-[13px] text-ink-3">Положил:</span>
                  <Stepper value={d} max={qty} onChange={(v) => onChange({ ...p, delivered: { ...p.delivered, [key]: v } })} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
    bar = (
      <div className="space-y-2">
        <div className="text-[15px]">
          Положить: <span className="num font-bold">{deliveredHere}</span> {plural(deliveredHere, "блюдо", "блюда", "блюд")}
        </div>
        <button
          disabled={busy}
          onClick={() => (nextStop === undefined ? onFinish({ ...p, phase: "done" }) : onChange({ ...p, stopIndex: nextStop }))}
          className="h-16 w-full rounded-2xl bg-good text-[18px] font-bold text-white active:scale-[0.99] disabled:opacity-50"
        >
          {busy ? "Отправляю…" : nextStop === undefined ? "ГОТОВО" : `ГОТОВО → ${r.stops[nextStop].name}`}
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg pt-[env(safe-area-inset-top)]">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <button onClick={onPause} className="h-11 rounded-xl px-2 text-[15px] text-ink-3">
          ‹ Пауза
        </button>
        <div className="flex flex-1 justify-center gap-1.5">
          {Array.from({ length: totalSteps }, (_, i) => (
            <span key={i} className={clsx("h-1.5 w-7 rounded-full", i < step ? "bg-ink" : "bg-surface-3")} />
          ))}
        </div>
        <span className="num w-14 text-right text-[14px] text-ink-3">
          {step}/{totalSteps}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-4 pt-5">
        <div className="text-[14px] font-bold tracking-[0.16em] text-ink-3">{header.title}</div>
        <div className="mb-4 mt-1 text-[32px] font-extrabold leading-tight">{header.place}</div>
        {body}
      </div>
      {/* sticky action bar — always visible, one-handed */}
      <div className="border-t border-line bg-bg px-4 pb-[calc(12px+env(safe-area-inset-bottom))] pt-3">
        {err && <p className="mb-2 text-[14px] text-crit-ink">{err}</p>}
        {bar}
      </div>
    </div>
  );
}

// ───────────────────────── success ─────────────────────────

function Success({ r, result }: { r: MobileRoute; result: { xp: XpGain[]; impact?: CompletionImpact; queued?: boolean; skipped?: boolean } }) {
  const total = result.xp.reduce((a, g) => a + g.amount, 0);
  return (
    <div className="flex min-h-[100dvh] flex-col bg-bg px-5 pb-[calc(20px+env(safe-area-inset-bottom))] pt-[calc(40px+env(safe-area-inset-top))]">
      <div className={clsx("rise mx-auto grid h-20 w-20 place-items-center rounded-full text-[40px]", result.skipped ? "bg-surface-3 text-ink-2" : "bg-good/20 text-good-ink")}>
        {result.skipped ? "–" : "✓"}
      </div>
      <h1 className="mt-5 text-center text-[24px] font-extrabold tracking-wide">{result.skipped ? "ТОЧКА ПРОПУЩЕНА" : "ЗАДАЧА ВЫПОЛНЕНА"}</h1>
      <div className="mt-1 text-center text-[15px] text-ink-3">
        {r.sourceName} → {r.stops.map((s) => s.name).join(" → ")}
      </div>

      {result.queued ? (
        <div className="card mt-6 p-4 text-center text-[15px] text-warn">Нет связи. Результат сохранён на телефоне и отправится автоматически.</div>
      ) : result.skipped ? (
        <p className="mt-6 text-center text-[15px] text-ink-2">Спасибо — это тоже полезная информация: система учтёт её в следующих рекомендациях.</p>
      ) : (
        <>
          <div className="num mt-6 text-center text-[44px] font-extrabold text-xp">+{total} XP</div>
          <div className="card mt-4 space-y-2 p-4 text-[15px]">
            {result.xp.map((g) => (
              <div key={g.reason} className="flex justify-between">
                <span className="text-ink-2">{g.reason}</span>
                <span className="num text-xp">+{g.amount}</span>
              </div>
            ))}
          </div>
          {result.impact && (
            <div className="mt-4 space-y-2 text-[16px]">
              {result.impact.savedSales > 0 && <div>🔥 Вы спасли {result.impact.savedSales} потенциальных продаж</div>}
              {result.impact.wasteReduced > 0 && <div>♻️ Снизили риск списания на {result.impact.wasteReduced} {plural(result.impact.wasteReduced, "позицию", "позиции", "позиций")}</div>}
              {result.impact.unlockedAchievements.map((a) => (
                <div key={a} className="text-serious">🏅 Новое достижение: {a}</div>
              ))}
              {result.impact.unlockedRewards.map((a) => (
                <div key={a} className="text-xp">🎁 Награда «{a}» разблокирована. Обратитесь к администратору.</div>
              ))}
            </div>
          )}
          <p className="mt-4 text-[13px] text-ink-3">Через 2 часа система проверит, продались ли блюда. За хороший результат будут бонус и OPS POINTS.</p>
          <MissionKitShopStatus missionId={r.id} />
        </>
      )}

      <div className="mt-auto space-y-2 pt-8">
        <Link href="/m" className="flex h-16 items-center justify-center rounded-2xl bg-ink text-[18px] font-bold text-bg">
          Следующая задача
        </Link>
        <Link href="/m/tasks" className="flex h-12 items-center justify-center text-[15px] text-ink-3">
          Все задачи
        </Link>
      </div>
    </div>
  );
}
