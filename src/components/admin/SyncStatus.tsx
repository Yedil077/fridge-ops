"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { api } from "@/lib/client/api";
import type { LiveStatus } from "@/lib/server/kitshopLive";
import type { Runtime } from "@/lib/server/runtime";

interface Data {
  mode: string;
  shadow: boolean;
  readOnly: boolean;
  status: LiveStatus | null;
  compare: Awaited<ReturnType<Runtime["shadowCompare"]>>;
  endpoints: { name: string; method: string }[];
  hint?: string;
}

/** server wall-clock values already are Almaty time ("UTC fields = local") */
const fmtWall = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString("ru-RU", { timeZone: "UTC" }) : "—");
const day = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().slice(0, 10) : "—");
const n = (v: number) => v.toLocaleString("ru-RU");
const ago = (now: number, ms: number | null) => {
  if (!ms) return "";
  const m = Math.round((now - ms) / 60_000);
  return m < 1 ? " · только что" : m < 120 ? ` · ${m} мин назад` : ` · ${Math.round(m / 60)} ч назад`;
};

/** Admin: KiT Shop → our database sync (read only): last syncs, counts, 180-day backfill, the 15 points. */
export function SyncStatus() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ["admin", "sync"], queryFn: () => api<Data>("/api/admin/sync"), refetchInterval: 15_000 });
  if (!data) return null;
  const s = data.status;

  async function syncNow(catalog: boolean) {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/admin/sync", { method: "POST", body: JSON.stringify({ catalog }) });
      await qc.invalidateQueries({ queryKey: ["admin", "sync"] });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-bold">Синхронизация KiT Shop → Apps Холодосов</h2>
        <span className="rounded bg-good/20 px-2 py-0.5 text-[11px] font-bold tracking-wider text-good-ink">{data.readOnly ? "ТОЛЬКО ЧТЕНИЕ" : "ЗАПИСЬ РАЗРЕШЕНА"}</span>
      </div>
      {!s ? (
        <p className="mt-2 text-[13px] text-warn">
          Экраны показывают SIMULATOR. {data.hint}
        </p>
      ) : (
        <>
          {data.shadow && (
            <p className="mt-2 rounded-lg bg-accent/15 px-3 py-2 text-[13px] text-accent">
              SHADOW MODE: реальные данные KiT Shop синхронизируются и прогнозируются параллельно, но пользователи пока видят прежние экраны (SIMULATOR).
              Переключение на реальные данные — только после проверки (DATA_SOURCE=kitshop).
            </p>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-line p-3 text-[13px] md:grid-cols-5">
            <Big label="История" value={`${s.progress.daysDone} / ${s.progress.daysTotal} дн.`} />
            <Big label="Чеки" value={n(s.progress.receipts)} sub={`с позициями ${n(s.progress.receiptsDetailed)} · в очереди ${n(s.progress.receiptsPending)}${s.progress.receiptsRetrying ? ` · повтор ${n(s.progress.receiptsRetrying)}` : ""}`} />
            <Big label="Позиции (товары в чеках)" value={n(s.progress.items)} />
            <Big label="Последняя успешная синхронизация" value={fmtWall(s.lastSuccessAt)} sub={ago(s.now, s.lastSuccessAt).replace(" · ", "")} />
            <Big label="Текущая дата догрузки" value={day(s.progress.currentBackfillDate)} sub={`нагрузка: ${s.progress.limits.concurrency} запрос(а), пауза ${s.progress.limits.delayMs} мс`} />
          </div>
          {s.memory && s.analytics && (
            <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-line p-3 text-[13px] md:grid-cols-5">
              <Big label="Память сервера (RSS)" value={`${s.memory.rssMb} МБ`} sub={`куча JS ${s.memory.heapUsedMb} МБ`} />
              <Big label="Запуск сервера" value={s.memory.startupMs === null ? "—" : `${(s.memory.startupMs / 1000).toFixed(1)} с`} />
              <Big label="Строк в памяти" value={n(s.memory.rowsInMemory)} sub={s.memory.historyRowsInDb !== null ? `в базе ${n(s.memory.historyRowsInDb)} (не загружаются)` : undefined} />
              <Big
                label="Ночной расчёт"
                value={s.analytics.running ? "идёт…" : s.analytics.runAt ? fmtWall(s.analytics.runAt) : "ещё не было"}
                sub={`${s.analytics.nextAt}${s.analytics.ms !== null ? ` · ${(s.analytics.ms / 1000).toFixed(1)} с` : ""}${s.analytics.lastError ? ` · ошибка: ${s.analytics.lastError}` : ""}`}
              />
              <Big label="Прочитано расчётом" value={s.analytics.rowsRead ? n(s.analytics.rowsRead.receipts) : "—"} sub={s.analytics.rowsRead ? `чеков · ${n(s.analytics.rowsRead.lines)} позиций · ${n(s.analytics.rowsRead.fillupLines)} загрузок` : undefined} />
            </div>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2 text-[13px] md:grid-cols-4">
            <Tile label="Источник на экранах" value={data.shadow ? "SIMULATOR (shadow)" : s.label} tone={s.label === "KITSHOP REAL" && !data.shadow ? "good" : "warn"} />
            <Tile label="Строк остатков (точка × товар)" value={n(s.counts.stockRows)} />
            <Tile label="Продажи за 24 ч (чеков)" value={n(s.counts.salesLast24h)} />
            <Tile label="Ошибки за 24 ч" value={String(s.errors24h.count)} tone={s.errors24h.count ? "warn" : "good"} />
            <Tile
              label="Категории"
              value={s.categorizedBy ? `по группе KiT Shop ${s.categorizedBy.group} · по названию ${s.categorizedBy.name}` : `групп в KiT Shop: ${s.counts.groups}`}
            />
            <Tile label="Последняя успешная синхронизация" value={`${fmtWall(s.lastSuccessAt)}${ago(s.now, s.lastSuccessAt)}`} />
            <Tile label="Остатки (GetShopStocks)" value={`${fmtWall(s.lastStockSyncAt)}${ago(s.now, s.lastStockSyncAt)}`} />
            <Tile label="Продажи (GetSales)" value={`${fmtWall(s.lastSalesSyncAt)}${ago(s.now, s.lastSalesSyncAt)}`} />
            <Tile label="Каталог (GetShops/GetProducts)" value={`${fmtWall(s.lastCatalogSyncAt)}${ago(s.now, s.lastCatalogSyncAt)}`} />
            <Tile label="Точек / товаров в KiT Shop" value={`${s.counts.shops} / ${s.counts.products}`} />
            <Tile label="Чеков / с позициями" value={`${s.counts.sales} / ${s.counts.salesDetailed}`} />
            <Tile label="Продано единиц (в копии)" value={String(s.counts.units)} />
            <Tile label="Самая старая / новая продажа" value={`${fmtWall(s.counts.oldestSale)} — ${fmtWall(s.counts.newestSale)}`} />
            <Tile
              label={`Догрузка истории ${s.progress.daysTotal} дней`}
              value={s.backlog.backfillDaysLeft > 0 || s.backlog.undetailed > 0 ? `осталось ${s.backlog.backfillDaysLeft} дн. · ${s.backlog.undetailed} чеков без позиций` : "готово"}
              tone={s.backlog.backfillDaysLeft > 0 || s.backlog.undetailed > 0 ? "warn" : "good"}
            />
            <Tile label="Хранилище" value={s.repo === "postgres" ? "PostgreSQL (ks_*)" : s.repo} />
            <Tile label="Последняя ошибка" value={s.lastError ? `${fmtWall(s.lastErrorAt)} · ${s.lastError}` : "—"} tone={s.lastError ? "bad" : undefined} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button disabled={busy || s.running} onClick={() => syncNow(false)} className="h-9 rounded-lg bg-accent/20 px-3 text-[13px] font-semibold text-accent disabled:opacity-40">
              {busy || s.running ? "Синхронизация…" : "СИНХРОНИЗИРОВАТЬ СЕЙЧАС"}
            </button>
            <button disabled={busy || s.running} onClick={() => syncNow(true)} className="h-9 rounded-lg bg-surface-3 px-3 text-[13px] disabled:opacity-40">
              + обновить каталог
            </button>
            <span className="text-[12px] text-ink-3">Автоматически каждые 5 минут; каталог — раз в 6 часов. Только методы чтения: {data.endpoints.map((e) => e.method).join(", ")}.</span>
          </div>
          {err && <p className="mt-2 text-[13px] text-crit-ink">{err}</p>}
          {s.errors24h.last.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[12px] text-warn">
              {s.errors24h.last.map((e, i) => (
                <li key={i}>
                  {fmtWall(e.at)} · {e.step}: {e.error}
                </li>
              ))}
            </ul>
          )}
          {data.compare && <Compare c={data.compare} />}
          {s.lastTick && (
            <p className="mt-2 text-[12px] text-ink-3">
              Последний проход ({s.lastTick.ms} мс): {s.lastTick.steps.filter((x) => !x.step.startsWith("GetShopStocks ")).map((x) => `${x.step} ${x.ok ? x.count : "ОШИБКА"}`).join(" · ")}
            </p>
          )}
          <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[760px] text-[12px] [&_td]:px-2 [&_td]:whitespace-nowrap [&_th]:px-2 [&_th]:whitespace-nowrap">
            <thead className="text-left text-ink-3">
              <tr>
                <th className="py-1">Точка</th>
                <th>ShopId</th>
                <th>В KiT Shop</th>
                <th className="text-right">Блюд в остатке (без приборов)</th>
                <th>Остатки на</th>
                <th className="text-right">Сегодня: чеков / шт</th>
                <th className="text-right">За час: чеков / шт</th>
                <th>Последняя продажа</th>
              </tr>
            </thead>
            <tbody>
              {s.fridges.map((f) => (
                <tr key={f.id} className="border-t border-line">
                  <td className="py-1.5">{f.name}</td>
                  <td className="num">{f.shopId}</td>
                  <td className={f.inKitShop ? "text-good-ink" : "text-crit-ink"}>{f.inKitShop ? "да" : s.counts.shops ? "НЕТ" : "—"}</td>
                  <td className="num text-right">{f.stockItems}</td>
                  <td>{fmtWall(f.stockAt)}</td>
                  <td className="num text-right">{f.receiptsToday} / {f.unitsToday}</td>
                  <td className="num text-right">{f.receiptsLastHour} / {f.unitsLastHour}</td>
                  <td>{fmtWall(f.lastSaleAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}
    </section>
  );
}

function Compare({ c }: { c: NonNullable<Data["compare"]> }) {
  if (!c.ready) return <p className="mt-3 text-[13px] text-warn">Сравнение real vs mock: {c.message}</p>;
  return (
    <div className="mt-4">
      <h3 className="text-[14px] font-bold">Сравнение: реальные данные (прогноз параллельно) vs SIMULATOR</h3>
      <p className="text-[12px] text-ink-3">
        Товаров в реальном прогнозе: {c.products}
        {c.categorizedBy ? ` (категория по группе KiT Shop: ${c.categorizedBy.group}, по названию: ${c.categorizedBy.name})` : ""} · рекомендаций: real {c.realRecommendations} / mock{" "}
        {c.mockRecommendations}
      </p>
      <div className="overflow-x-auto">
        <table className="mt-2 w-full min-w-[720px] text-[12px] [&_td]:px-2 [&_td]:whitespace-nowrap [&_th]:px-2 [&_th]:whitespace-nowrap">
          <thead className="text-left text-ink-3">
            <tr>
              <th className="py-1">Точка</th>
              <th className="text-right">Остаток real / mock</th>
              <th className="text-right">Продано сегодня real / mock</th>
              <th className="text-right">Посл. час real</th>
              <th className="text-right">Прогноз 2 ч real / mock</th>
              <th>Статус real / mock</th>
            </tr>
          </thead>
          <tbody>
            {c.rows.map((r) => (
              <tr key={r.shopId} className="border-t border-line">
                <td className="py-1.5">{r.name}</td>
                <td className="num text-right">{r.real.stock} / {r.mock?.stock ?? "—"}</td>
                <td className="num text-right">{r.real.salesToday} / {r.mock?.salesToday ?? "—"}</td>
                <td className="num text-right">{r.real.lastHour}</td>
                <td className="num text-right">{r.real.expected2h} / {r.mock?.expected2h ?? "—"}</td>
                <td>{r.real.status} / {r.mock?.status ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Big({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className="num mt-0.5 text-[18px] font-bold">{value}</div>
      {sub && <div className="text-[11px] text-ink-3">{sub}</div>}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" | "bad" }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className={clsx("mt-0.5 break-words font-semibold", tone === "good" && "text-good-ink", tone === "warn" && "text-warn", tone === "bad" && "text-crit-ink")}>{value}</div>
    </div>
  );
}
