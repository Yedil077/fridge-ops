"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { api, atLeast, useMe } from "@/lib/client/api";
import type { TomorrowView } from "@/lib/server/tomorrowView";

type Cell = TomorrowView["cells"][number];

const CONF_CLS: Record<Cell["confidence"], string> = { HIGH: "", MEDIUM: "", LOW: "text-warn" };
const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

/**
 * ЗАВТРА — how many of each dish to put into each fridge tomorrow. Rows = tomorrow's menu (set by the kitchen / manager),
 * columns = fridges, whole units; on the right "ИТОГО НУЖНО ПРОИЗВЕСТИ". A click on a cell: why, and the manager's own number.
 */
export function TomorrowScreen({ mobile = false }: { mobile?: boolean }) {
  const [date, setDate] = useState<string | null>(null);
  const { data, error, isFetching } = useQuery({
    queryKey: ["tomorrow", date],
    queryFn: () => api<TomorrowView>(`/api/tomorrow${date ? `?date=${date}` : ""}`),
    refetchInterval: 5 * 60_000,
  });
  const me = useMe().data;
  const canEdit = atLeast(me, "MANAGER");
  const [open, setOpen] = useState<{ shopId: string; productId: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  if (error) return <p className="p-6 text-crit-ink">{(error as Error).message}</p>;
  if (!data) return <p className="p-6 text-ink-3">Собираю план на завтра…</p>;

  const cellOf = (shopId: string, productId: string) => data.cells.find((c) => c.shopId === shopId && c.productId === productId);
  const cell = open ? cellOf(open.shopId, open.productId) : undefined;
  const shift = (d: number) => setDate(isoOf(Date.parse(`${data.date}T00:00:00Z`) + d * 86_400_000));

  return (
    <div>
      {/* header */}
      <section className="card flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
        <div>
          <div className="label">ЗАВТРА</div>
          <div className="flex items-center gap-2">
            <button onClick={() => shift(-1)} className="h-8 w-8 rounded-lg bg-surface-2" aria-label="Предыдущий день">
              ‹
            </button>
            <div className="text-[22px] font-bold">{ddmmyyyy(data.date)}</div>
            <button onClick={() => shift(1)} className="h-8 w-8 rounded-lg bg-surface-2" aria-label="Следующий день">
              ›
            </button>
          </div>
        </div>
        <Fact label="Статус данных" value={data.status.label} tone={data.status.label === "ГОТОВО" ? "good" : "warn"} />
        <Fact label="Последний расчёт" value={data.status.analysisAt ? hhmm(data.status.analysisAt) : "—"} />
        <Fact label="Меню" value={`${data.menu.length} блюд`} />
        <Fact label="Холодильников" value={String(data.fridges.length)} />
        <Fact label="Всего поставить" value={`${data.grandTotal} шт.`} />
        {canEdit && (
          <button onClick={() => setMenuOpen(true)} className="ml-auto h-10 rounded-xl bg-ink px-4 font-semibold text-bg">
            Меню на {ddmmyyyy(data.date).slice(0, 5)}
          </button>
        )}
        {isFetching && <span className="text-[12px] text-ink-3">обновляю…</span>}
      </section>
      {data.status.fridgesWithFailedChecks.length > 0 && (
        <p className="mt-2 rounded-xl bg-warn/10 px-3 py-2 text-[12px]">
          ⚠️ У {data.status.fridgesWithFailedChecks.length} холодильников не пройдена проверка данных — их числа с НИЗКОЙ уверенностью (жёлтые). Подробности — в Аналитике.
        </p>
      )}

      {data.menu.length === 0 ? (
        <div className="card mt-4 p-6 text-center">
          <div className="text-[16px] font-semibold">Меню на {ddmmyyyy(data.date)} ещё не задано</div>
          <p className="mt-1 text-[13px] text-ink-3">Apps Холодосов не выбирает блюда — меню задаёт кухня или менеджер. После этого здесь появится, сколько каждого блюда ставить в каждый холодильник.</p>
          {canEdit && (
            <button onClick={() => setMenuOpen(true)} className="mt-3 h-10 rounded-xl bg-ink px-4 font-semibold text-bg">
              Задать меню
            </button>
          )}
        </div>
      ) : mobile ? (
        <div className="mt-3 space-y-2">
          {data.menu.map((m) => (
            <details key={m.productId} className="card p-3">
              <summary className="flex cursor-pointer items-center justify-between gap-2">
                <span className="font-semibold">{m.name}</span>
                <span className="num whitespace-nowrap text-[15px] font-bold">{data.totals[m.productId]} шт.</span>
              </summary>
              <div className="mt-2 grid grid-cols-2 gap-1 text-[13px]">
                {data.fridges.map((f) => {
                  const c = cellOf(f.shopId, m.productId)!;
                  return (
                    <button key={f.shopId} onClick={() => setOpen({ shopId: f.shopId, productId: m.productId })} className="flex justify-between rounded-lg bg-surface-2 px-2 py-1 text-left">
                      <span className="truncate">{f.short}</span>
                      <QtyText c={c} />
                    </button>
                  );
                })}
              </div>
            </details>
          ))}
        </div>
      ) : (
        <div className="card mt-4 overflow-x-auto p-0">
          <table className="w-full text-[13px] [&_td]:px-2 [&_th]:px-2">
            <thead className="text-[11px] uppercase tracking-wide text-ink-3">
              <tr className="border-b border-line">
                <th className="sticky left-0 bg-surface py-2 text-left">Блюдо</th>
                {data.fridges.map((f) => (
                  <th key={f.shopId} className="whitespace-nowrap text-right" title={f.name}>
                    {f.short}
                  </th>
                ))}
                <th className="whitespace-nowrap bg-surface-2 text-right text-ink">Итого произвести</th>
              </tr>
            </thead>
            <tbody>
              {data.menu.map((m) => (
                <tr key={m.productId} className="border-b border-line last:border-0">
                  <td className="sticky left-0 bg-surface py-2">
                    <div className="font-semibold">{m.name}</div>
                  </td>
                  {data.fridges.map((f) => {
                    const c = cellOf(f.shopId, m.productId)!;
                    return (
                      <td key={f.shopId} className="text-right">
                        <button onClick={() => setOpen({ shopId: f.shopId, productId: m.productId })} className="w-full rounded px-1 py-1 text-right hover:bg-surface-2">
                          <QtyText c={c} />
                        </button>
                      </td>
                    );
                  })}
                  <td className="num bg-surface-2 text-right text-[15px] font-bold">{data.totals[m.productId]}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-line text-ink-2">
                <td className="sticky left-0 bg-surface py-2 font-semibold">Всего в холодильник</td>
                {data.fridges.map((f) => (
                  <td key={f.shopId} className="num text-right font-semibold">
                    {data.fridgeTotals[f.shopId]}
                  </td>
                ))}
                <td className="num bg-surface-2 text-right text-[15px] font-bold text-ink">{data.grandTotal}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[11px] text-ink-3">
        Целые штуки. Число = норма поставки этого блюда в этот холодильник (сколько обычно продаётся за срок годности) минус то, что будет ещё годным завтра утром. «?» — данных
        нет, число решает менеджер. Жёлтое — низкая уверенность. ✎ — число изменено вручную (рекомендация сохранена).
      </p>

      {cell && <CellCard c={cell} view={data} canEdit={canEdit} onClose={() => setOpen(null)} mobile={mobile} />}
      {menuOpen && <MenuEditor view={data} onClose={() => setMenuOpen(false)} />}
    </div>
  );
}

function QtyText({ c }: { c: Cell }) {
  const value = c.manualQty ?? c.qty;
  return (
    <span className={clsx("num font-bold", c.manualQty === null && CONF_CLS[c.confidence], c.tag === "НЕ РАБОТАЕТ" && "text-ink-3")}>
      {value === null ? "?" : value}
      {c.manualQty !== null ? <span className="text-[10px] text-accent"> ✎</span> : ""}
      {c.tag === "НОВЫЙ" && c.manualQty === null ? <span className="text-[10px] text-ink-3"> нов.</span> : ""}
    </span>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className={clsx("text-[15px] font-semibold", tone === "good" && "text-good-ink", tone === "warn" && "text-warn")}>{value}</div>
    </div>
  );
}

function CellCard({ c, view, canEdit, onClose, mobile }: { c: Cell; view: TomorrowView; canEdit: boolean; onClose: () => void; mobile: boolean }) {
  const qc = useQueryClient();
  const [v, setV] = useState(String(c.manualQty ?? c.qty ?? ""));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const dish = view.menu.find((m) => m.productId === c.productId);
  const fridge = view.fridges.find((f) => f.shopId === c.shopId);
  const save = async (qty: number | null) => {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/tomorrow/cell", { method: "PUT", body: JSON.stringify({ date: view.date, shopId: c.shopId, productId: c.productId, qty }) });
      await qc.invalidateQueries({ queryKey: ["tomorrow"] });
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className={clsx("h-full overflow-y-auto bg-bg p-4 shadow-xl", mobile ? "w-full" : "w-[460px]")} onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[19px] font-bold leading-tight">{dish?.name}</h2>
            <div className="text-[13px] text-ink-3">{fridge?.name}</div>
          </div>
          <button onClick={onClose} className="h-9 w-9 shrink-0 rounded-lg bg-surface-2 text-[18px]" aria-label="Закрыть">
            ×
          </button>
        </div>
        <section className="card mt-3 p-4">
          <div className="label">Завтра</div>
          <div className="text-[30px] font-bold leading-none">{c.qty === null ? "?" : `${c.qty} шт.`}</div>
          {c.range && c.qty !== null && <div className="mt-1 text-[13px] text-ink-2">допустимо {c.range.min === c.range.max ? c.range.min : `${c.range.min}–${c.range.max}`} шт.</div>}
          <div className={clsx("mt-1 text-[12px] font-semibold", c.confidence === "LOW" && "text-warn")}>
            Уверенность: {c.confidence === "HIGH" ? "ВЫСОКАЯ" : c.confidence === "MEDIUM" ? "СРЕДНЯЯ" : "НИЗКАЯ"}
            {c.tag ? ` · ${c.tag}` : ""}
          </div>
          {c.manualQty !== null && <div className="mt-1 text-[12px] text-accent">изменено вручную: {c.manualQty} шт. ({c.manualBy})</div>}
        </section>
        <section className="card mt-3 p-4 text-[13px]">
          <div className="label mb-1">Почему</div>
          {c.reason.deliveries.length > 0 && (
            <div className="mb-1">
              последние поставки (поставили → продано за срок): <b>{c.reason.deliveries.join(", ")}</b>
            </div>
          )}
          <div>списание: {c.reason.writeOff}</div>
          <div>ожидаемый годный остаток утром: {c.expectedLeft} шт.</div>
          {c.base !== null && <div>норма поставки: {c.base} шт.</div>}
          {c.reason.today && (
            <div>
              сегодня: поставили {c.reason.today.loaded}, уже продано {c.reason.today.soldSoFar}
            </div>
          )}
          <ul className="mt-1 list-disc pl-5 text-ink-2">
            {c.reason.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>
        {canEdit && (
          <section className="card mt-3 p-4 text-[13px]">
            <div className="label mb-1">Своё число</div>
            <div className="flex flex-wrap items-center gap-2">
              <input value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, ""))} inputMode="numeric" className="h-10 w-20 rounded-lg border border-line bg-surface px-2 text-right text-[16px]" />
              <span>шт.</span>
              <button disabled={busy || v === ""} onClick={() => save(Number(v))} className="h-10 rounded-lg bg-ink px-3 font-semibold text-bg disabled:opacity-40">
                Сохранить
              </button>
              {c.manualQty !== null && (
                <button disabled={busy} onClick={() => save(null)} className="h-10 rounded-lg px-2 underline">
                  вернуть рекомендацию
                </button>
              )}
            </div>
            <p className="mt-1 text-[11px] text-ink-3">Рекомендация системы сохраняется отдельно — потом сравним: рекомендовано / поставили / продалось.</p>
            {err && <p className="mt-1 text-crit-ink">{err}</p>}
          </section>
        )}
      </div>
    </div>
  );
}

function MenuEditor({ view, onClose }: { view: TomorrowView; onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["tomorrow-catalog"], queryFn: () => api<{ products: { productId: string; name: string; categoryId: string }[] }>("/api/tomorrow/catalog") });
  const [q, setQ] = useState("");
  const [copyFrom, setCopyFrom] = useState(isoOf(Date.parse(`${view.date}T00:00:00Z`) - 86_400_000));
  const [sheet, setSheet] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inMenu = new Set(view.menu.map((m) => m.productId));
  const found = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n.length < 2 ? [] : (data?.products ?? []).filter((p) => p.name.toLowerCase().includes(n)).slice(0, 30);
  }, [q, data]);
  const call = async (body: Record<string, unknown>, url = "/api/tomorrow/menu", method = "PUT") => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ matched?: { name: string }[]; unmatched?: string[] }>(url, { method, body: JSON.stringify({ date: view.date, ...body }) });
      if (r.matched) setMsg(`Из таблицы добавлено ${r.matched.length} блюд${r.unmatched?.length ? `; не нашлись в каталоге KiT Shop: ${r.unmatched.join(", ")}` : ""}`);
      await qc.invalidateQueries({ queryKey: ["tomorrow"] });
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className="h-full w-full max-w-[520px] overflow-y-auto bg-bg p-4 shadow-xl" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="flex items-start justify-between">
          <h2 className="text-[19px] font-bold">Меню на {ddmmyyyy(view.date)}</h2>
          <button onClick={onClose} className="h-9 w-9 rounded-lg bg-surface-2 text-[18px]" aria-label="Закрыть">
            ×
          </button>
        </div>
        <p className="mt-1 text-[12px] text-ink-3">Меню задаёт кухня или менеджер. Приложение считает только количество.</p>

        <section className="card mt-3 p-3">
          <div className="label mb-2">В меню ({view.menu.length})</div>
          {view.menu.map((m) => (
            <div key={m.productId} className="flex items-center justify-between gap-2 border-b border-line py-1 text-[13px] last:border-0">
              <span>{m.name}</span>
              <button disabled={busy} onClick={() => call({ remove: [m.productId] })} className="text-crit-ink underline">
                убрать
              </button>
            </div>
          ))}
          {!view.menu.length && <p className="text-[13px] text-ink-3">Пусто</p>}
        </section>

        <section className="card mt-3 p-3">
          <div className="label mb-2">Добавить блюдо</div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Название блюда" className="h-10 w-full rounded-lg border border-line bg-surface px-3" />
          {found.map((p) => (
            <div key={p.productId} className="flex items-center justify-between gap-2 border-b border-line py-1 text-[13px] last:border-0">
              <span>{p.name}</span>
              {inMenu.has(p.productId) ? (
                <span className="text-ink-3">в меню</span>
              ) : (
                <button disabled={busy} onClick={() => call({ add: [p.productId] })} className="font-semibold underline">
                  добавить
                </button>
              )}
            </div>
          ))}
        </section>

        <section className="card mt-3 p-3 text-[13px]">
          <div className="label mb-2">Скопировать меню другого дня</div>
          <div className="flex gap-2">
            <input type="date" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} className="h-10 rounded-lg border border-line bg-surface px-2" />
            <button disabled={busy} onClick={() => call({ copyFrom })} className="h-10 rounded-lg bg-surface-3 px-3 font-semibold">
              Скопировать
            </button>
          </div>
        </section>

        <section className="card mt-3 p-3 text-[13px]">
          <div className="label mb-2">Из Google Sheets (только чтение)</div>
          <div className="flex gap-2">
            <input value={sheet} onChange={(e) => setSheet(e.target.value)} placeholder="Название листа с меню" className="h-10 flex-1 rounded-lg border border-line bg-surface px-3" />
            <button disabled={busy || !sheet} onClick={() => call({ sheet }, "/api/tomorrow/import", "POST")} className="h-10 rounded-lg bg-surface-3 px-3 font-semibold">
              Прочитать
            </button>
          </div>
          <p className="mt-1 text-[11px] text-ink-3">Берутся строки листа, где первая ячейка — название блюда (или ProductId) из каталога KiT Shop. В таблицу ничего не записывается.</p>
        </section>
        {msg && <p className="mt-2 text-[13px]">{msg}</p>}
      </div>
    </div>
  );
}
