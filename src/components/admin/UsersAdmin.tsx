"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { api } from "@/lib/client/api";

type Role = "EMPLOYEE" | "MANAGER" | "ADMIN";

interface AdminUser {
  id: string;
  login: string;
  name: string;
  role: Role;
  active: boolean;
  activeSessions: number;
}

interface AdminSession {
  id: string;
  user: string;
  role: Role;
  device: string;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

const ROLE_LABEL: Record<Role, string> = { EMPLOYEE: "Сотрудник", MANAGER: "Менеджер", ADMIN: "Администратор" };
const input = "h-10 rounded-lg border border-line-strong bg-bg px-3 text-[14px] outline-none focus:border-accent";

function ago(ms: number) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "только что";
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} ч назад` : `${Math.round(h / 24)} дн назад`;
}

/** Users (login + PIN, roles) and device sessions. PINs are never shown or stored in plain text. */
export function UsersAdmin() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["admin", "users"], queryFn: () => api<{ users: AdminUser[] }>("/api/admin/users") });
  const sessions = useQuery({ queryKey: ["admin", "sessions"], queryFn: () => api<{ sessions: AdminSession[] }>("/api/admin/sessions") });
  const [form, setForm] = useState({ login: "", name: "", role: "EMPLOYEE" as Role, pin: "" });
  const create = useMutation({
    mutationFn: () => api("/api/admin/users", { method: "POST", body: JSON.stringify(form) }),
    onSuccess: () => {
      setForm({ login: "", name: "", role: "EMPLOYEE", pin: "" });
      qc.invalidateQueries({ queryKey: ["admin"] });
    },
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin"] }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/admin/sessions/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin"] }),
  });

  return (
    <section className="mt-8 space-y-4">
      <div className="card p-4">
        <div className="label mb-1">Сотрудники</div>
        <p className="mb-3 text-[12px] text-ink-3">Вход по логину и PIN (4–8 цифр). PIN хранится только в виде хеша. Смена PIN или отключение сразу выходит из аккаунта на всех устройствах.</p>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input className={clsx(input, "w-32")} placeholder="логин" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} />
          <input className={clsx(input, "w-44")} placeholder="имя" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select className={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </select>
          <input
            className={clsx(input, "w-28")}
            placeholder="PIN"
            inputMode="numeric"
            value={form.pin}
            onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, "").slice(0, 8) })}
          />
          <button
            disabled={create.isPending || !form.login || !form.name || form.pin.length < 4}
            onClick={() => create.mutate()}
            className="h-10 rounded-lg bg-ink px-4 text-[13px] font-semibold text-bg disabled:opacity-30"
          >
            Добавить
          </button>
          {create.error && <span className="text-[12px] text-crit-ink">{(create.error as Error).message}</span>}
        </div>
        <table className="w-full text-[13px]">
          <tbody>
            {users.data?.users.map((u) => (
              <tr key={u.id} className={clsx("border-t border-line", !u.active && "opacity-50")}>
                <td className="py-2 pr-3">
                  <div className="font-semibold">{u.name}</div>
                  <div className="font-mono text-[11px] text-ink-3">{u.login}</div>
                </td>
                <td className="py-2 pr-3">
                  <select
                    className={clsx(input, "h-9")}
                    value={u.role}
                    onChange={(e) => patch.mutate({ id: u.id, body: { role: e.target.value } })}
                  >
                    {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                      <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-3 text-ink-3">{u.activeSessions} устр.</td>
                <td className="space-x-2 py-2 text-right">
                  <button
                    className="h-9 rounded-lg border border-line-strong px-3 text-[12px]"
                    onClick={() => {
                      const pin = prompt(`Новый PIN для ${u.name} (4–8 цифр):`);
                      if (pin) patch.mutate({ id: u.id, body: { pin } });
                    }}
                  >
                    Сменить PIN
                  </button>
                  <button className="h-9 rounded-lg border border-line-strong px-3 text-[12px]" onClick={() => patch.mutate({ id: u.id, body: { revokeSessions: true } })}>
                    Выйти везде
                  </button>
                  <button
                    className={clsx("h-9 rounded-lg px-3 text-[12px]", u.active ? "border border-crit/40 text-crit-ink" : "border border-line-strong")}
                    onClick={() => patch.mutate({ id: u.id, body: { active: !u.active } })}
                  >
                    {u.active ? "Отключить" : "Включить"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {patch.error && <p className="mt-2 text-[12px] text-crit-ink">{(patch.error as Error).message}</p>}
      </div>

      <div className="card p-4">
        <div className="label mb-3">Активные сессии (устройства)</div>
        <table className="w-full text-[13px]">
          <tbody>
            {sessions.data?.sessions.map((s) => (
              <tr key={s.id} className="border-t border-line">
                <td className="py-2 pr-3">
                  {s.user} <span className="text-[11px] text-ink-3">· {ROLE_LABEL[s.role]}</span>
                </td>
                <td className="max-w-[320px] truncate py-2 pr-3 text-[12px] text-ink-3" title={s.device}>{s.device}</td>
                <td className="py-2 pr-3 text-ink-3">{ago(s.lastSeenAt)}</td>
                <td className="py-2 text-right">
                  {s.current ? (
                    <span className="text-[12px] text-ink-3">это устройство</span>
                  ) : (
                    <button className="h-9 rounded-lg border border-crit/40 px-3 text-[12px] text-crit-ink" onClick={() => revoke.mutate(s.id)}>
                      Отозвать
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
