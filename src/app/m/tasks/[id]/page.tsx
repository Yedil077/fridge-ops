"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useQueryClient } from "@tanstack/react-query";
import { MobileShell } from "@/components/mobile/MobileShell";
import { DishRow, SkeletonList, UrgencyPill, plural } from "@/components/mobile/ui";
import { useMobileTask, type MobileRoute } from "@/lib/client/mobileApi";
import type { CompletionImpact, MissionActionResult, XpGain } from "@/lib/client/api";
import { clearProgress, loadProgress, saveProgress, sendOrQueue, type RouteProgress } from "@/lib/client/offline";

type Item = MobileRoute["stops"][number]["items"][number];

interface PickItem {
  productId: string;
  name: string;
  sku: string;
  emoji: string;
  color: string;
  categoryName: string;
  planned: number;
}

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

/** If the fridge had less of a dish, earlier stops get it first. Returns actual qty per stop item. */
function distribute(r: MobileRoute, actual: Record<string, number>): Map<string, number> {
  const left = new Map<string, number>();
  for (const p of pickList(r)) left.set(p.productId, actual[p.productId] ?? p.planned);
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

export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error } = useMobileTask(id);
  const qc = useQueryClient();
  const [progress, setProgress] = useState<RouteProgress | null>(null);
  const [details, setDetails] = useState(false);
  const [result, setResult] = useState<{ xp: XpGain[]; impact?: CompletionImpact; queued?: boolean } | null>(null);
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
    update({ phase: "pick", stopIndex: 0, checked: {}, actual: {}, updatedAt: Date.now() });
    try {
      await sendOrQueue(`/api/missions/${r.id}`, "PATCH", { action: "start" });
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function finish(p: RouteProgress) {
    setBusy(true);
    setErr(null);
    const dist = distribute(r, p.actual);
    const items = r.stops.flatMap((s, si) =>
      s.items.map((i) => {
        const q = dist.get(`${si}:${i.lineIndex}:${i.productId}`) ?? i.qty;
        return { lineIndex: i.lineIndex, productId: i.productId, qty: q, unavailable: q < i.qty };
      }),
    );
    try {
      const res = await sendOrQueue<MissionActionResult>(`/api/missions/${r.id}`, "PATCH", { action: "complete", items });
      clearProgress(r.id);
      if (res.queued) setResult({ xp: [], queued: true });
      else setResult({ xp: res.data.xp, impact: res.data.impact });
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
        <div className="label mt-4">Возьми</div>
        <div className="mt-2 space-y-2">
          {pickList(r).map((p) => (
            <DishRow key={p.productId} name={p.name} sku={p.sku} emoji={p.emoji} color={p.color} categoryName={p.categoryName} qty={p.planned} />
          ))}
        </div>
        <div className="mt-2 text-right text-[14px] text-ink-3">
          Итого: {r.totalItems} {plural(r.totalItems, "позиция", "позиции", "позиций")}
        </div>
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
              Пропустить
            </button>
          )}
        </div>
      ) : (
        <div className="card mt-5 p-4 text-center text-[15px] text-ink-2">
          {r.status === "COMPLETED" ? "✓ Задача выполнена" : r.status === "SKIPPED" ? "Задача пропущена" : "Задача устарела — есть более свежий план"}
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

// ───────────────────────── fullscreen checklist ─────────────────────────

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
  const [editing, setEditing] = useState<string | null>(null);
  const picks = useMemo(() => pickList(r), [r]);
  const dist = useMemo(() => distribute(r, p.actual), [r, p.actual]);
  const totalSteps = 1 + r.stops.length;
  const step = p.phase === "pick" ? 1 : p.stopIndex + 2;

  const toggle = (key: string) => onChange({ ...p, checked: { ...p.checked, [key]: !p.checked[key] } });

  let title: string;
  let place: string;
  let body: React.ReactNode;
  let allChecked: boolean;
  let cta: string;
  let next: () => void;

  if (p.phase === "pick") {
    title = "ЗАБЕРИ ИЗ";
    place = r.sourceName;
    allChecked = picks.every((x) => p.checked[`p:${x.productId}`]);
    cta = "ВСЁ ЗАБРАЛ";
    next = () => onChange({ ...p, phase: "drop", stopIndex: 0 });
    body = picks.map((x) => {
      const key = `p:${x.productId}`;
      const actual = p.actual[x.productId] ?? x.planned;
      return (
        <div key={key}>
          <DishRow
            name={x.name}
            sku={x.sku}
            emoji={x.emoji}
            color={x.color}
            categoryName={x.categoryName}
            qty={actual}
            checked={!!p.checked[key]}
            onToggle={() => toggle(key)}
            strike={actual === 0}
          />
          {actual < x.planned && <div className="mt-1 px-2 text-[13px] text-warn">Было нужно {x.planned}, взял {actual} — это нормально, система учтёт</div>}
          {editing === key ? (
            <div className="mt-2 flex items-center gap-2 rounded-2xl border border-line bg-surface-2 p-2">
              <span className="px-2 text-[14px] text-ink-2">Есть только</span>
              <button
                className="h-12 w-12 rounded-xl bg-surface-3 text-[22px]"
                onClick={() => onChange({ ...p, actual: { ...p.actual, [x.productId]: Math.max(0, actual - 1) } })}
                aria-label="Меньше"
              >
                −
              </button>
              <span className="num w-10 text-center text-[22px] font-bold">{actual}</span>
              <button
                className="h-12 w-12 rounded-xl bg-surface-3 text-[22px]"
                onClick={() => onChange({ ...p, actual: { ...p.actual, [x.productId]: Math.min(x.planned, actual + 1) } })}
                aria-label="Больше"
              >
                +
              </button>
              <button className="ml-auto h-12 rounded-xl bg-ink px-4 text-[15px] font-semibold text-bg" onClick={() => setEditing(null)}>
                OK
              </button>
            </div>
          ) : (
            <button onClick={() => setEditing(key)} className="mt-1 h-10 px-2 text-[14px] text-ink-3">
              Нет столько? Есть только…
            </button>
          )}
        </div>
      );
    });
  } else {
    const s = r.stops[p.stopIndex];
    title = "НЕСИ В";
    place = s.name;
    const items = s.items
      .map((i) => ({ i, qty: dist.get(`${p.stopIndex}:${i.lineIndex}:${i.productId}`) ?? i.qty }))
      .filter((x) => x.qty > 0);
    allChecked = items.every(({ i }) => p.checked[`${p.stopIndex}:${i.lineIndex}:${i.productId}`]);
    const last = p.stopIndex === r.stops.length - 1;
    cta = last ? "ГОТОВО" : `ГОТОВО → ${r.stops[p.stopIndex + 1].name}`;
    next = () => (last ? onFinish({ ...p, phase: "done" }) : onChange({ ...p, stopIndex: p.stopIndex + 1 }));
    body = items.length ? (
      items.map(({ i, qty }: { i: Item; qty: number }) => {
        const key = `${p.stopIndex}:${i.lineIndex}:${i.productId}`;
        return (
          <DishRow
            key={key}
            name={i.name}
            sku={i.sku}
            emoji={i.emoji}
            color={i.color}
            categoryName={i.categoryName}
            qty={qty}
            checked={!!p.checked[key]}
            onToggle={() => toggle(key)}
            hint={i.hint}
          />
        );
      })
    ) : (
      <div className="card p-4 text-[15px] text-ink-2">Для этой точки блюд не осталось — нажмите «Готово».</div>
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
            <span key={i} className={clsx("h-1.5 w-8 rounded-full", i < step ? "bg-ink" : "bg-surface-3")} />
          ))}
        </div>
        <span className="num w-14 text-right text-[14px] text-ink-3">
          {step}/{totalSteps}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-4 pt-5">
        <div className="text-[14px] font-bold tracking-[0.16em] text-ink-3">{title}</div>
        <div className="mt-1 text-[34px] font-extrabold leading-tight">{place}</div>
        <div className="mt-5 space-y-3">{body}</div>
      </div>
      <div className="border-t border-line bg-bg px-4 pb-[calc(12px+env(safe-area-inset-bottom))] pt-3">
        {err && <p className="mb-2 text-[14px] text-crit-ink">{err}</p>}
        <button
          disabled={!allChecked || busy}
          onClick={next}
          className={clsx("h-16 w-full rounded-2xl text-[18px] font-bold transition", allChecked ? "bg-good text-white active:scale-[0.99]" : "bg-surface-3 text-ink-3")}
        >
          {busy ? "Отправляю…" : allChecked ? cta : "Отметьте все позиции"}
        </button>
      </div>
    </div>
  );
}

// ───────────────────────── success ─────────────────────────

function Success({ r, result }: { r: MobileRoute; result: { xp: XpGain[]; impact?: CompletionImpact; queued?: boolean } }) {
  const total = result.xp.reduce((a, g) => a + g.amount, 0);
  return (
    <div className="flex min-h-[100dvh] flex-col bg-bg px-5 pb-[calc(20px+env(safe-area-inset-bottom))] pt-[calc(40px+env(safe-area-inset-top))]">
      <div className="rise mx-auto grid h-20 w-20 place-items-center rounded-full bg-good/20 text-[40px] text-good-ink">✓</div>
      <h1 className="mt-5 text-center text-[24px] font-extrabold tracking-wide">ЗАДАЧА ВЫПОЛНЕНА</h1>
      <div className="mt-1 text-center text-[15px] text-ink-3">
        {r.sourceName} → {r.stops.map((s) => s.name).join(" → ")}
      </div>

      {result.queued ? (
        <div className="card mt-6 p-4 text-center text-[15px] text-warn">Нет связи. Результат сохранён на телефоне и отправится автоматически.</div>
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
