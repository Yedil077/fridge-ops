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
  workingDays: number[];
  opening: string;
  closing: string;
}

interface AdminData {
  mode: string;
  fridges: AdminFridge[];
  travelOverrides: Record<string, number>;
}

interface RewardsData {
  claims: { id: string; user: string; title: string; points: number; unlockedAt: number; issuedAt: number | null; issuedBy: string | null }[];
  players: { name: string; xp: number; points: number }[];
}

const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export default function AdminPage() {
  const { data, error } = useQuery({ queryKey: ["admin", "fridges"], queryFn: () => api<AdminData>("/api/admin/fridges") });
  const rewards = useQuery({ queryKey: ["admin", "rewards"], queryFn: () => api<RewardsData>("/api/admin/rewards") });

  return (
    <Shell>
      <h1 className="text-[22px] font-semibold tracking-tight">Настройки</h1>
      <p className="mt-1 max-w-2xl text-[13px] text-ink-3">
        Имена, которые видят сотрудники. Внутренний ID источника данных (external_id) не меняется, поэтому переименовывать можно в любой момент.
      </p>
      {error && <p className="mt-4 text-crit-ink">{(error as Error).message}</p>}
      {data?.mode === "mock" && (
        <p className="mt-3 rounded-lg border border-line bg-surface px-3 py-2 text-[12px] text-ink-3">
          Режим симулятора: график влияет на рекомендации, но симулятор продолжает генерировать продажи по исходному графику.
        </p>
      )}

      <UsersAdmin />

      <h2 className="mt-10 text-[18px] font-semibold">Холодильники</h2>
      <section className="mt-3 space-y-3">
        {data?.fridges.map((f) => <FridgeRow key={f.id} f={f} />)}
      </section>

      {data && <TravelForm fridges={data.fridges} overrides={data.travelOverrides} />}

      <section className="card mt-8 p-4">
        <div className="label mb-3">Награды</div>
        {!rewards.data?.claims.length ? (
          <p className="text-[13px] text-ink-3">Пока никто не открыл награду. Вехи: 1000 / 3000 / 5000 OPS POINTS.</p>
        ) : (
          <table className="w-full text-[13px]">
            <tbody>
              {rewards.data.claims.map((c) => (
                <RewardRow key={c.id} c={c} />
              ))}
            </tbody>
          </table>
        )}
        {rewards.data && rewards.data.players.length > 0 && (
          <div className="mt-4 border-t border-line pt-3 text-[12px] text-ink-3">
            {rewards.data.players.map((p) => (
              <span key={p.name} className="mr-4">
                {p.name}: <span className="text-ink-2">{p.points} pts</span> · {p.xp} XP
              </span>
            ))}
          </div>
        )}
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

function RewardRow({ c }: { c: RewardsData["claims"][number] }) {
  const qc = useQueryClient();
  const issue = useMutation({
    mutationFn: () => api("/api/admin/rewards", { method: "POST", body: JSON.stringify({ claimId: c.id }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "rewards"] }),
  });
  return (
    <tr className="border-b border-line last:border-0">
      <td className="py-2">🎁 {c.title}</td>
      <td className="py-2 text-ink-2">{c.user}</td>
      <td className="num py-2 text-ink-3">{c.points} pts</td>
      <td className="py-2 text-right">
        {c.issuedAt ? (
          <span className="text-good-ink">выдано{c.issuedBy ? ` (${c.issuedBy})` : ""}</span>
        ) : (
          <button onClick={() => issue.mutate()} disabled={issue.isPending} className="h-9 rounded-lg bg-ink px-3 text-[12px] font-semibold text-bg">
            Отметить выдачу
          </button>
        )}
      </td>
    </tr>
  );
}
