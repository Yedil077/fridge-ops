"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";

const LAST_LOGIN = "fo-last-login";

/**
 * Employee login: login + PIN, once per device. The session then lives in an httpOnly cookie
 * (up to 180 days, revocable by an admin). Only the login name is remembered locally — never the PIN.
 */
export default function LoginPage() {
  const [login, setLogin] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const last = localStorage.getItem(LAST_LOGIN);
      if (last) {
        setLogin(last);
        pinRef.current?.focus();
      }
    } catch {
      /* storage unavailable */
    }
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ user: { role: string } }>("/api/auth/login", { method: "POST", body: JSON.stringify({ login, pin }) });
      try {
        localStorage.setItem(LAST_LOGIN, login.trim());
      } catch {
        /* ignore */
      }
      window.location.href = r.user.role === "EMPLOYEE" ? "/m" : "/";
    } catch (err) {
      setError((err as Error).message);
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-[100dvh] place-items-center px-4 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]">
      <form onSubmit={submit} className="card w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-xl border border-line-strong bg-surface-2 text-[20px]">❄</span>
          <div>
            <div className="text-[18px] font-semibold">Apps Холодосов</div>
            <div className="text-[13px] text-ink-3">Вход для сотрудников</div>
          </div>
        </div>
        <label className="label mb-1.5 block">Логин</label>
        <input
          autoFocus
          autoCapitalize="none"
          autoComplete="username"
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          placeholder="например, anna"
          className="mb-4 h-12 w-full rounded-xl border border-line-strong bg-bg px-4 text-[16px] outline-none focus:border-accent"
        />
        <label className="label mb-1.5 block">PIN</label>
        <input
          ref={pinRef}
          type="password"
          inputMode="numeric"
          pattern="\d*"
          autoComplete="current-password"
          maxLength={8}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          placeholder="••••"
          className="num mb-4 h-14 w-full rounded-xl border border-line-strong bg-bg px-4 text-center text-[26px] tracking-[0.5em] outline-none focus:border-accent"
        />
        {error && <p className="mb-3 text-[14px] text-crit-ink">{error}</p>}
        <button
          disabled={busy || login.trim().length < 2 || pin.length < 4}
          className="h-14 w-full rounded-xl bg-ink text-[16px] font-semibold text-bg transition hover:bg-white disabled:opacity-40"
        >
          {busy ? "Вхожу…" : "Войти"}
        </button>
        <p className="mt-4 text-center text-[12px] text-ink-3">Вход сохраняется на этом устройстве. Забыли PIN — обратитесь к администратору.</p>
      </form>
    </div>
  );
}
