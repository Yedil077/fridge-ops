"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { api } from "@/lib/client/api";
import type { LiveStatus } from "@/lib/server/kitshopLive";

interface Data {
  mode: string;
  readOnly: boolean;
  status: LiveStatus | null;
  endpoints: { name: string; method: string }[];
  hint?: string;
}

/** server wall-clock values already are Almaty time ("UTC fields = local") */
const fmtWall = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString("ru-RU", { timeZone: "UTC" }) : "—");
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
          <div className="mt-3 grid grid-cols-2 gap-2 text-[13px] md:grid-cols-4">
            <Tile label="Источник на экранах" value={s.label} tone={s.label === "KITSHOP REAL" ? "good" : "warn"} />
            <Tile label="Последняя успешная синхронизация" value={`${fmtWall(s.lastSuccessAt)}${ago(s.now, s.lastSuccessAt)}`} />
            <Tile label="Остатки (GetShopStocks)" value={`${fmtWall(s.lastStockSyncAt)}${ago(s.now, s.lastStockSyncAt)}`} />
            <Tile label="Продажи (GetSales)" value={`${fmtWall(s.lastSalesSyncAt)}${ago(s.now, s.lastSalesSyncAt)}`} />
            <Tile label="Каталог (GetShops/GetProducts)" value={`${fmtWall(s.lastCatalogSyncAt)}${ago(s.now, s.lastCatalogSyncAt)}`} />
            <Tile label="Точек / товаров в KiT Shop" value={`${s.counts.shops} / ${s.counts.products}`} />
            <Tile label="Чеков / с позициями" value={`${s.counts.sales} / ${s.counts.salesDetailed}`} />
            <Tile label="Продано единиц (в копии)" value={String(s.counts.units)} />
            <Tile label="Самая старая / новая продажа" value={`${fmtWall(s.counts.oldestSale)} — ${fmtWall(s.counts.newestSale)}`} />
            <Tile
              label="Догрузка истории 180 дней"
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
          {s.lastTick && (
            <p className="mt-2 text-[12px] text-ink-3">
              Последний проход ({s.lastTick.ms} мс): {s.lastTick.steps.filter((x) => !x.step.startsWith("GetShopStocks ")).map((x) => `${x.step} ${x.ok ? x.count : "ОШИБКА"}`).join(" · ")}
            </p>
          )}
          <table className="mt-3 w-full text-[12px]">
            <thead className="text-left text-ink-3">
              <tr>
                <th className="py-1">Точка</th>
                <th>ShopId</th>
                <th>В KiT Shop</th>
                <th className="text-right">Остаток, шт</th>
                <th>Остатки на</th>
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
                  <td>{fmtWall(f.lastSaleAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
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
