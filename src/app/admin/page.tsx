"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Shell } from "@/components/Shell";
import { api } from "@/lib/client/api";
import { UsersAdmin } from "@/components/admin/UsersAdmin";

interface AdminFridge {
  id: string;
  externalId: string;
  code: string;
  displayName: string;
  shortName: string;
  location: string;
  priority: 1 | 2 | 3;
  proximityGroup: string;
  transferGroup: string;
  workingDays: number[];
  opening: string;
  closing: string;
}

interface AdminData {
  mode: string;
  fridges: AdminFridge[];
  travelOverrides: Record<string, number>;
}

const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export default function AdminPage() {
  const { data, error } = useQuery({ queryKey: ["admin", "fridges"], queryFn: () => api<AdminData>("/api/admin/fridges") });

  return (
    <Shell>
      <h1 className="text-[22px] font-semibold tracking-tight">Настройки</h1>
      <p className="mt-1 max-w-2xl text-[13px] text-ink-3">
        Имена, которые видят сотрудники. Внутренний ID источника данных (external_id) не меняется, поэтому переименовывать можно в любой момент.
        Еда перемещается <b>только между холодильниками с одинаковой «группой перемещения»</b> (например, SATTI или KABLAN_KANKORD). Пустая группа — без перемещений.
      </p>
      {error && <p className="mt-4 text-crit-ink">{(error as Error).message}</p>}
      {data?.mode === "mock" && (
        <p className="mt-3 rounded-lg border border-line bg-surface px-3 py-2 text-[12px] text-ink-3">
          График — только подсказка: движок учится по фактическим продажам (в том числе ночью и в выходные). Расхождения видны как SCHEDULE MISMATCH на странице точки и в Analytics → Время.
          Закрытие раньше открытия (например 18:00–02:00) означает работу через полночь.
        </p>
      )}

      <UntilTimeSetting />
      <ShelfLifeSetting />

      <UsersAdmin />

      <h2 className="mt-10 text-[18px] font-semibold">Холодильники</h2>
      <section className="mt-3 space-y-3">
        {data?.fridges.map((f) => <FridgeRow key={f.id} f={f} />)}
      </section>

      {data && <TravelForm fridges={data.fridges} overrides={data.travelOverrides} />}

      <section className="card mt-8 p-4">
        <div className="label mb-2">Developer / Diagnostics</div>
        <p className="text-[13px] text-ink-3">Статус KiT Shop, синхронизация, ошибки, проверка связи — для администратора.</p>
        <a href="/admin/kitshop/diagnostics" className="mt-3 inline-flex h-10 items-center rounded-lg bg-surface-3 px-4 text-[13px] font-semibold">
          Открыть диагностику KiT Shop
        </a>
      </section>
    </Shell>
  );
}

function FridgeRow({ f }: { f: AdminFridge }) {
  const qc = useQueryClient();
  const [v, setV] = useState(f);
  const dirty = JSON.stringify(v) !== JSON.stringify(f);
  const save = useMutation({
    mutationFn: () =>
      api("/api/admin/fridges", {
        method: "PUT",
        body: JSON.stringify({
          id: f.id,
          displayName: v.displayName,
          shortName: v.shortName,
          location: v.location,
          priority: v.priority,
          proximityGroup: v.proximityGroup,
          transferGroup: v.transferGroup,
          workingDays: v.workingDays,
          opening: v.opening,
          closing: v.closing,
        }),
      }),
    onSuccess: () => qc.invalidateQueries(),
  });
  const input = "h-10 rounded-lg border border-line-strong bg-bg px-3 text-[14px] outline-none focus:border-accent";
  return (
    <div className="card grid gap-3 p-4 lg:grid-cols-[1.2fr_0.8fr_1.4fr_auto]">
      <div className="space-y-2">
        <label className="block">
          <span className="label">Название (display_name)</span>
          <input className={clsx(input, "mt-1 w-full text-[16px] font-semibold")} value={v.displayName} onChange={(e) => setV({ ...v, displayName: e.target.value })} />
        </label>
        <div className="text-[11px] text-ink-3">
          external_id: <span className="font-mono">{f.externalId}</span> · id: <span className="font-mono">{f.id}</span>
        </div>
      </div>
      <div className="space-y-2">
        <label className="block">
          <span className="label">Короткое имя</span>
          <input className={clsx(input, "mt-1 w-full")} value={v.shortName} onChange={(e) => setV({ ...v, shortName: e.target.value })} />
        </label>
        <label className="block">
          <span className="label">Группа перемещения</span>
          <input
            className={clsx(input, "mt-1 w-full font-mono uppercase")}
            placeholder="SATTI"
            value={v.transferGroup}
            onChange={(e) => setV({ ...v, transferGroup: e.target.value })}
          />
        </label>
        <label className="block">
          <span className="label">Зона близости</span>
          <input className={clsx(input, "mt-1 w-full")} placeholder="например, Центр" value={v.proximityGroup} onChange={(e) => setV({ ...v, proximityGroup: e.target.value })} />
        </label>
      </div>
      <div className="space-y-2">
        <label className="block">
          <span className="label">Локация</span>
          <input className={clsx(input, "mt-1 w-full")} value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {WD.map((d, i) => {
            const on = v.workingDays.includes(i + 1);
            return (
              <button
                key={d}
                onClick={() => setV({ ...v, workingDays: on ? v.workingDays.filter((x) => x !== i + 1) : [...v.workingDays, i + 1].sort() })}
                className={clsx("h-9 w-9 rounded-lg text-[12px]", on ? "bg-surface-3 text-ink" : "border border-line text-ink-3")}
              >
                {d}
              </button>
            );
          })}
          <input className={clsx(input, "w-20")} value={v.opening} onChange={(e) => setV({ ...v, opening: e.target.value })} />
          <span className="text-ink-3">–</span>
          <input className={clsx(input, "w-20")} value={v.closing} onChange={(e) => setV({ ...v, closing: e.target.value })} />
        </div>
      </div>
      <div className="flex flex-col justify-between gap-2">
        <label className="block">
          <span className="label">Приоритет</span>
          <select className={clsx(input, "mt-1 w-full")} value={v.priority} onChange={(e) => setV({ ...v, priority: Number(e.target.value) as 1 | 2 | 3 })}>
            <option value={1}>низкий</option>
            <option value={2}>обычный</option>
            <option value={3}>высокий</option>
          </select>
        </label>
        <button
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
          className="h-10 rounded-lg bg-ink px-4 text-[13px] font-semibold text-bg disabled:opacity-30"
        >
          {save.isPending ? "Сохраняю…" : save.isSuccess && !dirty ? "Сохранено" : "Сохранить"}
        </button>
        {save.error && <span className="text-[12px] text-crit-ink">{(save.error as Error).message}</span>}
      </div>
    </div>
  );
}

function TravelForm({ fridges, overrides }: { fridges: AdminFridge[]; overrides: Record<string, number> }) {
  const qc = useQueryClient();
  const [a, setA] = useState(fridges[0]?.id ?? "");
  const [b, setB] = useState(fridges[1]?.id ?? "");
  const [min, setMin] = useState(5);
  const name = (id: string) => fridges.find((f) => f.id === id)?.displayName ?? id;
  const save = useMutation({
    mutationFn: (minutes: number | null) => api("/api/admin/travel", { method: "PUT", body: JSON.stringify({ a, b, minutes }) }),
    onSuccess: () => qc.invalidateQueries(),
  });
  const input = "h-10 rounded-lg border border-line-strong bg-bg px-3 text-[14px] outline-none focus:border-accent";
  return (
    <section className="card mt-8 p-4">
      <div className="label mb-1">Время в пути</div>
      <p className="mb-3 text-[12px] text-ink-3">Если координат нет — задайте вручную, сколько минут идти между точками. Точки одной зоны считаются рядом (≤ 5 мин).</p>
      <div className="flex flex-wrap items-center gap-2">
        <select className={input} value={a} onChange={(e) => setA(e.target.value)}>
          {fridges.map((f) => <option key={f.id} value={f.id}>{f.displayName}</option>)}
        </select>
        <span className="text-ink-3">↔</span>
        <select className={input} value={b} onChange={(e) => setB(e.target.value)}>
          {fridges.map((f) => <option key={f.id} value={f.id}>{f.displayName}</option>)}
        </select>
        <input type="number" min={1} max={240} className={clsx(input, "w-20")} value={min} onChange={(e) => setMin(Number(e.target.value) || 1)} />
        <span className="text-[13px] text-ink-3">мин</span>
        <button disabled={a === b} onClick={() => save.mutate(min)} className="h-10 rounded-lg bg-ink px-4 text-[13px] font-semibold text-bg disabled:opacity-30">
          Сохранить
        </button>
      </div>
      {Object.keys(overrides).length > 0 && (
        <ul className="mt-3 space-y-1 text-[13px]">
          {Object.entries(overrides).map(([k, v]) => {
            const [x, y] = k.split(">");
            return (
              <li key={k} className="flex items-center gap-3">
                <span className="text-ink-2">{name(x)} ↔ {name(y)}</span>
                <span className="num">{v} мин</span>
                <button
                  className="text-[12px] text-ink-3 hover:text-crit-ink"
                  onClick={() => api("/api/admin/travel", { method: "PUT", body: JSON.stringify({ a: x, b: y, minutes: null }) }).then(() => qc.invalidateQueries())}
                >
                  убрать
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Clock time of the user forecast mode "ДО HH:MM" — not a closing time of the fridges. */
function UntilTimeSetting() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin", "settings"], queryFn: () => api<{ untilTime: string }>("/api/admin/settings") });
  const [v, setV] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (untilTime: string) => api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ untilTime }) }),
    onSuccess: () => qc.invalidateQueries(),
  });
  const value = v ?? data?.untilTime ?? "20:00";
  return (
    <section className="card mt-6 p-4">
      <div className="label mb-2">Режим прогноза «ДО HH:MM»</div>
      <p className="mb-3 text-[13px] text-ink-3">
        Пользовательский горизонт: спрос от текущего времени до этого часа. Это не время закрытия точек — после него режим просто недоступен до следующего дня.
      </p>
      <div className="flex items-center gap-2">
        <input type="time" value={value} onChange={(e) => setV(e.target.value)} className="h-10 rounded-lg border border-line bg-surface px-3 text-[14px]" />
        <button
          onClick={() => save.mutate(value)}
          disabled={save.isPending}
          className="h-10 rounded-lg bg-surface-3 px-4 text-[13px] font-semibold disabled:opacity-40"
        >
          {save.isPending ? "…" : "Сохранить"}
        </button>
      </div>
    </section>
  );
}

const SHELF_CATS: [string, string][] = [
  ["hot", "🔥 Горячее"],
  ["salad", "🥗 Салаты"],
  ["breakfast", "🥐 Завтраки"],
  ["snack", "🥪 Перекусы"],
  ["dessert", "🍰 Десерты"],
  ["drink", "🥤 Напитки"],
];

/** Срок годности по категориям (часы): за это время поставка должна продаться — на нём строится норма поставки. */
function ShelfLifeSetting() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["admin", "settings"],
    queryFn: () => api<{ untilTime: string; shelfLife: { categories: Record<string, number>; products: Record<string, number> } }>("/api/admin/settings"),
  });
  const [edit, setEdit] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (categories: Record<string, number>) => api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ shelfLife: { categories } }) }),
    onSuccess: () => {
      setEdit({});
      void qc.invalidateQueries();
    },
  });
  const cats = data?.shelfLife?.categories ?? {};
  const changed = Object.fromEntries(Object.entries(edit).filter(([, v]) => /^\d+$/.test(v)).map(([k, v]) => [k, Number(v)]));
  const overrides = Object.keys(data?.shelfLife?.products ?? {}).length;
  return (
    <section className="card mt-6 p-4">
      <div className="label mb-2">Срок годности (часы)</div>
      <p className="mb-3 text-[13px] text-ink-3">
        Аналитика считает каждую поставку: сколько поставили → сколько продалось за срок годности → сколько сняли и списали. Для отдельного блюда срок можно изменить в
        его карточке в Аналитике{overrides ? ` (сейчас изменено у ${overrides} блюд)` : ""}.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {SHELF_CATS.map(([id, name]) => (
          <label key={id} className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
            <span>{name}</span>
            <input
              inputMode="numeric"
              value={edit[id] ?? String(cats[id] ?? "")}
              onChange={(e) => setEdit({ ...edit, [id]: e.target.value.replace(/\D/g, "") })}
              className="h-9 w-16 rounded-md border border-line bg-surface px-2 text-right"
            />
          </label>
        ))}
      </div>
      <button
        onClick={() => save.mutate(changed)}
        disabled={save.isPending || !Object.keys(changed).length}
        className="mt-3 h-10 rounded-lg bg-surface-3 px-4 text-[13px] font-semibold disabled:opacity-40"
      >
        {save.isPending ? "…" : "Сохранить"}
      </button>
      {save.error && <p className="mt-2 text-[12px] text-crit-ink">{(save.error as Error).message}</p>}
    </section>
  );
}
