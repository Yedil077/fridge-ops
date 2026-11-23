"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { api, atLeast, useMe } from "@/lib/client/api";
import type { NightView } from "@/lib/server/nightView";

type Stop = NightView["stops"][number];
type Night = NightView & { sheet?: { connected: boolean; hours: number[]; last: { at: number; ok: boolean; text: string } | null } };

const pad = (n: number) => String(n).padStart(2, "0");
const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * НОЧЬ — the night driver's route: stop by stop, what to take, write off, put from another fridge and put new.
 * The driver sees only that; a manager can open "почему" for every line and the group totals of every fridge.
 */
export function NightScreen({ mobile = false }: { mobile?: boolean }) {
  const [date, setDate] = useState<string | null>(null);
  const { data, error, isFetching } = useQuery({
    queryKey: ["night", date],
    queryFn: () => api<Night>(`/api/night${date ? `?date=${date}` : ""}`),
    refetchInterval: 5 * 60_000,
  });
  const me = useMe().data;
  const manager = atLeast(me, "MANAGER");
  const [why, setWhy] = useState(false);
  const [hideEmpty, setHideEmpty] = useState(true);
  const qc = useQueryClient();
  const [reading, setReading] = useState<{ busy: boolean; text: string | null; ok: boolean }>({ busy: false, text: null, ok: true });
  const readSheet = async (d: string) => {
    setReading({ busy: true, text: null, ok: true });
    try {
      const r = await api<{ rows: number; units: number; changed: boolean }>("/api/night/plan/sync", { method: "POST", body: JSON.stringify({ date: d }) });
      setReading({ busy: false, ok: true, text: `Таблица прочитана: ${r.rows} строк, ${r.units} шт.${r.changed ? " — план обновлён" : " — без изменений"}` });
      await qc.invalidateQueries({ queryKey: ["night"] });
    } catch (e) {
      setReading({ busy: false, ok: false, text: (e as Error).message });
    }
  };

  if (error) return <p className="p-6 text-crit-ink">{(error as Error).message}</p>;
  if (!data) return <p className="p-6 text-ink-3">Собираю ночное задание…</p>;

  const shift = (d: number) => setDate(isoOf(Date.parse(`${data.date}T00:00:00Z`) + d * 86_400_000));
  const busy = (s: Stop) => s.take.length + s.put.length + s.writeOff.length + s.putNew.length + s.toBase.length > 0;
  const stops = data.stops.filter((s) => !hideEmpty || busy(s));
  let building = "";

  return (
    <div className={clsx(mobile && "pb-4")}>
      <section className="card flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
        <div>
          <div className="label">НОЧЬ НА</div>
          <div className="flex items-center gap-2">
            <button onClick={() => shift(-1)} className="h-8 w-8 rounded-lg bg-surface-2" aria-label="Предыдущая ночь">
              ‹
            </button>
            <div className="text-[22px] font-bold">{ddmm(data.date)}</div>
            <button onClick={() => shift(1)} className="h-8 w-8 rounded-lg bg-surface-2" aria-label="Следующая ночь">
              ›
            </button>
          </div>
        </div>
        <Fact label="Выезд" value={hhmm(data.start).slice(6)} />
        <Fact label="Статус" value={data.draft ? "ЧЕРНОВИК" : "ФИНАЛ"} tone={data.draft ? "warn" : "good"} />
        <Fact label="Перевезти" value={`${data.totals.moved} шт.`} />
        <Fact label="Списать" value={`${data.totals.writeOff} шт.`} />
        <Fact label="Новое" value={`${data.totals.fresh} шт.`} />
        {data.totals.toBase > 0 && <Fact label="На базу" value={`${data.totals.toBase} шт.`} tone="warn" />}
        {isFetching && <span className="text-[12px] text-ink-3">обновляю…</span>}
      </section>

      {!data.plan && (
        <p className="mt-2 rounded-xl bg-warn/10 px-3 py-2 text-[13px]">
          ⚠️ План новой продукции на {ddmm(data.date)} из таблицы ещё не загружен — поэтому сейчас только списания, без перемещений.
        </p>
      )}
      <p className="mt-2 text-[12px] text-ink-3">
        {data.plan ? `План: ${data.plan.source} · ${data.plan.units} шт. · загружен ${hhmm(data.plan.importedAt)} (${data.plan.importedBy}). ` : ""}
        Остатки KiT Shop: {data.stockAt ? hhmm(data.stockAt) : "—"}.{" "}
        {data.draft ? "Черновик: до выезда ещё будут продажи, финальное задание — около 00:30." : ""}
      </p>
      {manager && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
          <button onClick={() => void readSheet(data.date)} disabled={reading.busy || data.sheet?.connected === false} className="rounded-lg bg-surface-2 px-3 py-1.5 text-[13px] font-medium disabled:opacity-50">
            {reading.busy ? "Читаю таблицу…" : "Обновить из таблицы"}
          </button>
          <span className="text-ink-3">
            {data.sheet?.connected
              ? `Автоматически: ${data.sheet.hours.map((h) => `${pad(h)}:00`).join(" и ")} — план на завтра.`
              : "Таблица не подключена (MENU_SHEET_ID на сервере)."}
            {data.sheet?.last ? ` Последнее чтение ${hhmm(data.sheet.last.at)}: ${data.sheet.last.ok ? "" : "ошибка — "}${data.sheet.last.text}` : ""}
          </span>
          {reading.text && <span className={clsx("w-full", reading.ok ? "text-good-ink" : "text-crit-ink")}>{reading.text}</span>}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-3 text-[13px]">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} /> скрыть точки без действий
        </label>
        {manager && (
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={why} onChange={(e) => setWhy(e.target.checked)} /> почему (для менеджера)
          </label>
        )}
      </div>

      <ol className="mt-3 space-y-2">
        {stops.map((s, i) => {
          const head = s.building !== building;
          building = s.building;
          return (
            <li key={s.shopId}>
              {head && <div className="label mb-1 mt-3">{s.building}</div>}
              <StopCard s={s} n={i + 1} why={why && manager} names={new Map(data.stops.map((x) => [x.shopId, x.name]))} />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function StopCard({ s, n, why, names }: { s: Stop; n: number; why: boolean; names: Map<string, string> }) {
  const [open, setOpen] = useState(true);
  return (
    <article className={clsx("card p-3", s.role === "closed" && "border-warn")}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-baseline justify-between gap-2 text-left">
        <span className="text-[16px] font-semibold">
          {n}. {s.name}
          {s.role === "closed" && <span className="ml-2 text-[11px] text-warn">закрыта · вывезти всё</span>}
          {s.role === "low" && <span className="ml-2 text-[11px] text-ink-3">слабая точка</span>}
          {s.role === "isolated" && <span className="ml-2 text-[11px] text-ink-3">Заммлер</span>}
        </span>
        <span className="num whitespace-nowrap text-[12px] text-ink-3">
          {s.take.length ? `забрать ${s.take.reduce((a, l) => a + l.qty, 0)} · ` : ""}
          {s.put.length ? `привезти ${s.put.reduce((a, l) => a + l.qty, 0)} · ` : ""}
          новое {s.putNew.reduce((a, l) => a + l.qty, 0)}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2 text-[14px]">
          <Block title="ЗАБРАТЬ" tone="accent" lines={s.take.map((l) => ({ text: `${l.name} ×${l.qty}`, hint: `→ ${names.get(l.to) ?? l.to}`, why: l.reason, age: l.ageHours }))} why={why} />
          <Block title="СПИСАТЬ" tone="crit" lines={s.writeOff.map((l) => ({ text: `${l.name} ×${l.qty}`, why: l.reason, age: l.ageHours }))} why={why} />
          <Block title="НА БАЗУ (решает менеджер)" tone="warn" lines={s.toBase.map((l) => ({ text: `${l.name} ×${l.qty}`, why: l.reason, age: l.ageHours }))} why={why} />
          <Block title="ПОСТАВИТЬ ВЫГРУЗКУ" tone="accent" lines={s.put.map((l) => ({ text: `${l.name} ×${l.qty}`, hint: `из ${names.get(l.from) ?? l.from}`, why: l.reason, age: l.ageHours }))} why={why} />
          <Block title="ПОСТАВИТЬ НОВОЕ" lines={s.putNew.map((l) => ({ text: `${l.name} ×${l.qty}` }))} why={false} />
          {why && s.keep.length > 0 && <Block title="ОСТАЁТСЯ" lines={s.keep.map((l) => ({ text: `${l.name} ×${l.qty}`, why: l.reason, age: l.ageHours }))} why />}
          {why && s.groups.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] [&_td]:px-1.5 [&_th]:px-1.5">
                <thead className="text-left text-ink-3">
                  <tr className="border-b border-line">
                    <th className="py-1">Группа</th>
                    <th className="text-right">Обычно продаётся</th>
                    <th className="text-right">Остаётся</th>
                    <th className="text-right">Привезём</th>
                    <th className="text-right">Новое</th>
                    <th className="text-right">Будет</th>
                  </tr>
                </thead>
                <tbody>
                  {s.groups.map((g) => (
                    <tr key={g.group} className="border-b border-line last:border-0">
                      <td className="py-1">{g.group}</td>
                      <td className="num text-right">{g.demand ?? "—"}</td>
                      <td className="num text-right">{g.kept}</td>
                      <td className="num text-right">{g.received}</td>
                      <td className="num text-right">{g.fresh}</td>
                      <td className={clsx("num text-right font-semibold", g.demand !== null && g.after > g.demand * 1.3 && "text-warn")}>{g.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function Block({ title, lines, why, tone }: { title: string; lines: { text: string; hint?: string; why?: string; age?: number | null }[]; why: boolean; tone?: "accent" | "crit" | "warn" }) {
  if (!lines.length) return null;
  return (
    <div>
      <div className={clsx("text-[11px] font-semibold tracking-wide", tone === "crit" ? "text-crit-ink" : tone === "warn" ? "text-warn" : tone === "accent" ? "text-accent" : "text-ink-3")}>{title}</div>
      <ul>
        {lines.map((l, i) => (
          <li key={i} className="border-b border-line py-1 last:border-0">
            <div className="flex justify-between gap-2">
              <span className="font-medium">{l.text}</span>
              {l.hint && <span className="whitespace-nowrap text-ink-2">{l.hint}</span>}
            </div>
            {why && l.why && (
              <div className="text-[12px] text-ink-3">
                {l.age !== undefined && l.age !== null ? `стоит ${l.age} ч · ` : ""}
                {l.why}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
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
