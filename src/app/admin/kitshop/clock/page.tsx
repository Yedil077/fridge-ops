"use client";

import { useState, type ReactNode } from "react";
import { Shell } from "@/components/Shell";
import { api } from "@/lib/client/api";
import type { ClockDiagnostic } from "@/lib/server/kitshopClock";

const SHOPS: [string, string][] = [
  ["621287", "1 Шарипова 4 этаж"],
  ["621288", "2 Досмухамедова Запад 3 этаж"],
  ["621136", "3 Досмухамедова Восток 3 этаж"],
  ["622552", "4 Досмухамедова 5 этаж"],
  ["621583", "5 БЦ Сатти 1 этаж"],
  ["621826", "6 БЦ Сатти А2 этаж"],
  ["621586", "7 БЦ Сатти 4 этаж"],
  ["622550", "8 Конкорд 1 этаж"],
  ["621137", "9 Конкорд 2 этаж"],
  ["622554", "91 Конкорд 5 этаж"],
  ["621135", "92 Каблан 3 этаж"],
  ["621286", "93 Каблан 5 этаж"],
  ["622555", "94 Каблан 6 этаж"],
  ["622551", "95 Жибек Жолы 2 этаж"],
  ["622553", "Назарбаева 28/3"],
];

/**
 * Диагностика времени KiT Shop и новых чеков — на реальных ответах KiT Shop (только чтение).
 * Ничего не меняет: ни KiT Shop, ни нашу базу, ни настройки.
 */
export default function KitShopClockPage() {
  const [shop, setShop] = useState("621287");
  const [busy, setBusy] = useState(false);
  const [d, setD] = useState<ClockDiagnostic | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setD(await api<ClockDiagnostic>(`/api/admin/kitshop/clock?shop=${shop}`));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell>
      <h1 className="text-[22px] font-bold">Диагностика времени и новых чеков KiT Shop</h1>
      <p className="mb-3 text-[13px] text-ink-3">Реальные ответы KiT Shop, только чтение. Сравните 3 последних чека с кабинетом KiT Shop.</p>
      <div className="mb-4 flex flex-wrap gap-2">
        <select value={shop} onChange={(e) => setShop(e.target.value)} className="h-10 rounded-xl border border-line bg-surface px-3">
          {SHOPS.map(([id, n]) => (
            <option key={id} value={id}>
              {n} ({id})
            </option>
          ))}
        </select>
        <button onClick={run} disabled={busy} className="h-10 rounded-xl bg-ink px-4 font-semibold text-bg disabled:opacity-50">
          {busy ? "Спрашиваю KiT Shop…" : "Проверить"}
        </button>
      </div>
      {err && <p className="text-crit-ink">{err}</p>}
      {d && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Card title="1. Самый свежий чек точки">
            <Row k="ShopId" v={`${d.shop.shopId} — ${d.shop.name}`} />
            <Row k="Сейчас в Алматы (наши часы)" v={d.nowAlmaty ?? "—"} />
            <Row k="Сдвиг времени KiT Shop на сервере, мин" v={String(d.offsetMinutes)} />
            {d.newest ? (
              <>
                <Row k="Самый свежий SaleId" v={d.newest.saleId} />
                <Row k="SaleDateTime прямо из ответа KiT Shop" v={d.newest.raw} strong />
                <Row k="После нашего разбора (+ offset)" v={d.newest.parsed ?? "—"} />
                <Row k="Разница с «сейчас»" v={`${d.newest.ageMinutes} мин`} strong />
                <Row k="Чеков у точки за час до него" v={String(d.newest.receiptsInItsLastHour)} />
                <Row k="Есть у нас в ks_sales" v={d.newest.inKsSales ? "да" : "НЕТ"} />
              </>
            ) : (
              <p className="text-[13px] text-warn">KiT Shop не вернул чеков точки за ±12 ч.</p>
            )}
            <Row k="Запрос: UpDate / ToDate" v={`${d.probe.fromSent} — ${d.probe.toSent} (вернул ${d.probe.returned})`} />
            <Row k="Самый свежий чек точки у нас" v={d.storedNewestForShop ?? "—"} />
          </Card>

          <Card title="2. GetSales «новые чеки» — как его шлёт синхронизация (повтор сейчас)">
            <Row k="FromDateTime (UpDate) отправляем" v={d.syncRequestNow.fromSent} strong />
            <Row k="ToDateTime отправляем" v={d.syncRequestNow.toSent} strong />
            <Row k="API вернул чеков" v={String(d.syncRequestNow.returned)} />
            <Row k="Минимальное время в ответе" v={d.syncRequestNow.minRaw ?? "—"} />
            <Row k="Максимальное время в ответе" v={d.syncRequestNow.maxRaw ?? "—"} />
            <Row k="Уже есть в ks_sales" v={String(d.syncRequestNow.alreadyInKsSales)} />
            <Row k="Ещё нет в ks_sales" v={String(d.syncRequestNow.notYetInKsSales)} />
            <Row k="Время не читается" v={String(d.syncRequestNow.unreadableDates)} />
            {d.syncRequestNow.error && <Row k="Ошибка" v={d.syncRequestNow.error} />}
            <Row k="Последняя синхронизация (lastSalesSyncAt)" v={d.lastSalesSyncAt ?? "—"} />
          </Card>

          <Card title="3. Последний реальный шаг синхронизации «GetSales (новые)»">
            {d.lastSyncRequest ? (
              <>
                <Row k="UpDate / ToDate" v={`${d.lastSyncRequest.fromSent} — ${d.lastSyncRequest.toSent}`} />
                <Row k="Вернул" v={String(d.lastSyncRequest.returned)} />
                <Row k="Мин / макс время" v={`${d.lastSyncRequest.minRaw ?? "—"} / ${d.lastSyncRequest.maxRaw ?? "—"}`} />
                <Row k="Записано в ks_sales" v={String(d.lastSyncRequest.written)} strong />
                <Row k="Отброшено как дубликат" v={String(d.lastSyncRequest.duplicates)} />
                <Row k="Не записано: время не читается" v={String(d.lastSyncRequest.badDate)} />
                <Row k="Из записанных — чужие точки" v={String(d.lastSyncRequest.otherShops)} />
                {d.lastSyncRequest.error && <Row k="Ошибка" v={d.lastSyncRequest.error} />}
              </>
            ) : (
              <p className="text-[13px] text-ink-3">Записи ещё нет — появится после следующей синхронизации (до 5 минут после деплоя).</p>
            )}
          </Card>

          <Card title="4. Три последних чека — сверить с кабинетом KiT Shop">
            {d.last3.map((s) => (
              <div key={s.saleId} className="mb-2 border-b border-line pb-2 text-[13px] last:border-0">
                <div className="font-bold">
                  SaleId {s.saleId} · ShopId {s.shopId}
                </div>
                <div>
                  KiT Shop: <b>{s.raw}</b>
                  {s.rawFromSaleById && s.rawFromSaleById !== s.raw ? ` (GetSaleById: ${s.rawFromSaleById})` : ""} → у нас {s.parsed}
                </div>
                <div>{s.lines.map((l) => `${l.name} ×${l.qty}`).join(", ") || "—"}</div>
                <div className="text-ink-3">
                  в ks_sales: {s.inKsSales ? `да, время ${s.storedTime}, позиций ${s.storedLines?.length ?? 0}` : "НЕТ"}
                </div>
              </div>
            ))}
            {!d.last3.length && <p className="text-[13px] text-ink-3">Нет чеков.</p>}
          </Card>
          {d.errors.length > 0 && (
            <Card title="Ошибки KiT Shop">
              {d.errors.map((e) => (
                <p key={e} className="text-[13px] text-crit-ink">
                  {e}
                </p>
              ))}
            </Card>
          )}
        </div>
      )}
    </Shell>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card p-4">
      <div className="label mb-2">{title}</div>
      {children}
    </section>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3 border-b border-line py-1 text-[13px] last:border-0">
      <span className="text-ink-2">{k}</span>
      <span className={strong ? "num text-right font-bold" : "num text-right"}>{v}</span>
    </div>
  );
}
