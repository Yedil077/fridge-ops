"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";

interface Status {
  status: "idle" | "running" | "done" | "error";
  startedAt: number | null;
  finishedAt: number | null;
  startedBy: string | null;
  step: string;
  progress: number;
  error: string | null;
  summary: {
    delete: number;
    check: number;
    fresh: number;
    keep: number;
    total: number;
    dataReadAt: number;
    endpoints: { endpoint: string; ok: number; failed: number; note: string }[];
    complete: { products: boolean; sales: boolean; stocks: boolean; fillUps: boolean };
  } | null;
  ready: boolean;
  last: { name: string; finishedAt: number; startedBy: string | null } | null;
  auto: { on: boolean; everyHours: number; nextAt: number | null };
}

const URL_ = "/api/admin/reports/unused-products";
const fmt = (ms: number | null) => (ms ? new Date(ms).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" }) : "—");
/** server wall-clock values already are Almaty time ("UTC fields = local") */
const fmtWall = (ms: number | null) => (ms ? `${new Date(ms).toLocaleString("ru-RU", { timeZone: "UTC" })} (Алматы)` : "—");

/** Excel for managers: dishes that are no longer used in KiT Shop (real data, read-only). */
export function UnusedProductsReport({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const { data: s } = useQuery({
    queryKey: ["report", "unused"],
    queryFn: () => api<Status>(URL_),
    refetchInterval: (q) => (q.state.data?.status === "running" ? 2_000 : false),
  });
  const start = async () => {
    setErr(null);
    try {
      await api(URL_, { method: "POST" });
    } catch (e) {
      setErr((e as Error).message);
    }
    qc.invalidateQueries({ queryKey: ["report", "unused"] });
  };
  const running = s?.status === "running";
  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="label">Отчёт для менеджеров · что можно удалить из KiT Shop (Excel)</div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={start}
            disabled={running || !enabled}
            className="h-10 rounded-lg bg-accent/20 px-4 text-[13px] font-semibold text-accent disabled:opacity-40"
          >
            {running ? "Собираю…" : s?.ready ? "ОБНОВИТЬ СЕЙЧАС" : "СФОРМИРОВАТЬ"}
          </button>
          {s?.ready && (
            <a href={`${URL_}?download=1`} className="flex h-10 items-center rounded-lg bg-good/20 px-4 text-[13px] font-semibold text-good-ink">
              СКАЧАТЬ EXCEL
            </a>
          )}
        </div>
      </div>
      <p className="mt-1 text-[12px] text-ink-3">
        Каждый раз свежее чтение реального KiT Shop: каталог, продажи по товарам за ~6 месяцев, остатки во всех точках, все загрузки и снятия за 60 дней.
        По полным названиям: ТОЧНО УДАЛИТЬ (только при полной уверенности), ПРОВЕРИТЬ, ОСТАВИТЬ, НОВЫЕ. Новые товары и всё, что продавалось, загружалось или лежит в остатке, не удаляется. Ничего не удаляется автоматически.
        {!enabled && " Сейчас выключено: нужен доступ к KiT Shop на сервере (REAL_DIAGNOSTICS=true)."}
      </p>
      {s?.last && (
        <p className="mt-2 text-[13px]">
          Готовый файл: <b>{fmt(s.last.finishedAt)}</b>
          {s.last.startedBy ? ` (${s.last.startedBy})` : ""} — скачивается сразу, ждать не нужно. Файл хранится в базе и не пропадает, когда сервер засыпает.
        </p>
      )}
      {s?.auto.on && (
        <p className="mt-1 text-[12px] text-ink-3">
          Сервер обновляет отчёт сам раз в {s.auto.everyHours} ч{s.auto.nextAt ? ` · следующее обновление ≈ ${fmt(Math.max(s.auto.nextAt, Date.now()))}` : ""}.
          Помнить и нажимать кнопку не нужно.
        </p>
      )}
      {err && <p className="mt-2 rounded-lg bg-crit/15 px-3 py-2 text-[13px] text-crit-ink">{err}</p>}
      {running && s && (
        <div className="mt-3">
          <div className="h-2 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${s.progress}%` }} />
          </div>
          <div className="mt-1 text-[12px] text-ink-3">
            {s.progress}% · {s.step} · запущен {fmt(s.startedAt)}{s.startedBy ? ` (${s.startedBy})` : ""}. Занимает 10–25 минут, идёт на сервере —
            страницу можно закрыть. {s.last ? "Пока идёт обновление, скачивается предыдущий файл." : ""}
          </div>
        </div>
      )}
      {s?.status === "error" && <p className="mt-2 rounded-lg bg-crit/15 px-3 py-2 text-[13px] text-crit-ink">Ошибка на шаге «{s.step}»: {s.error}</p>}
      {s?.summary && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Cell label="ТОЧНО УДАЛИТЬ" v={s.summary.delete} tone="text-crit-ink" />
            <Cell label="ПРОВЕРИТЬ" v={s.summary.check} tone="text-warn" />
            <Cell label="НОВЫЕ" v={s.summary.fresh} tone="text-accent" />
            <Cell label="ОСТАВИТЬ" v={s.summary.keep} tone="text-good-ink" />
            <Cell label="всего названий" v={s.summary.total} tone="text-ink" />
          </div>
          <div className="mt-2 text-[12px] text-ink-3">
            Данные KiT Shop на {fmtWall(s.summary.dataReadAt)} ·{" "}
            {s.summary.endpoints.map((e) => `${e.endpoint}: ${e.failed ? `ошибок ${e.failed} из ${e.ok + e.failed}` : `OK (${e.ok})`}`).join(" · ")}
            {!Object.values(s.summary.complete).every(Boolean) && <span className="text-warn"> · данные неполные — «ТОЧНО УДАЛИТЬ» не выдаётся</span>}
          </div>
        </>
      )}
    </section>
  );
}

function Cell({ label, v, tone }: { label: string; v: number; tone: string }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2">
      <div className={`num text-[20px] font-bold ${tone}`}>{v}</div>
      <div className="text-[11px] text-ink-3">{label}</div>
    </div>
  );
}
