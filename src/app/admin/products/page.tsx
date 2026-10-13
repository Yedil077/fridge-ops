"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Shell } from "@/components/Shell";
import { api, useFlags } from "@/lib/client/api";
import type { productsAdmin } from "@/lib/server/opsViews";

type Data = Awaited<ReturnType<typeof productsAdmin>>;
type Row = Data["products"][number];

const MATCHED: Record<string, string> = { kitshop_id: "по id", barcode: "по штрихкоду", vendor_code: "по артикулу", manual: "вручную" };
const REASON: Record<string, string> = { not_found: "нет в KiT Shop", ambiguous: "несколько совпадений", stale: "привязка устарела" };

interface Preview {
  mode: string;
  method: string;
  body: Record<string, unknown>;
  notes: string[];
}

/**
 * Товары и KiT Shop: mapping status, catalog health, admin actions.
 * Matching: id → barcode → vendor code. Names are only suggestions and need a confirmation.
 * Nothing is ever deleted in KiT Shop: "deactivate" hides the product in Apps Холодосов only.
 */
export default function ProductsAdminPage() {
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ["admin", "products"], queryFn: () => api<Data>("/api/admin/products") });
  const { readOnly } = useFlags();
  const [filter, setFilter] = useState<"problems" | "all">("problems");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ row: Row; p: Preview } | null>(null);

  const rows = useMemo(() => {
    const list = data?.products ?? [];
    const needle = q.trim().toLowerCase();
    return list
      .filter((r) => filter === "all" || r.status !== "MAPPED" || r.inactive)
      .filter((r) => !needle || r.name.toLowerCase().includes(needle) || (r.barcode ?? "").includes(needle) || r.sku.toLowerCase().includes(needle));
  }, [data, filter, q]);

  async function post(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setMsg(null);
    try {
      const res = await api<Record<string, unknown>>("/api/admin/products", { method: "POST", body: JSON.stringify(body) });
      qc.invalidateQueries({ queryKey: ["admin", "products"] });
      qc.invalidateQueries({ queryKey: ["ops"] });
      return res;
    } catch (e) {
      setMsg((e as Error).message);
      return null;
    } finally {
      setBusy(null);
    }
  }

  if (error) return <Shell><p className="p-6 text-crit-ink">{(error as Error).message}</p></Shell>;

  const h = data?.health;
  return (
    <Shell>
      <div className="mx-auto max-w-5xl px-4 py-6">
        <h1 className="text-[22px] font-bold">Товары и KiT Shop</h1>
        <p className="mt-1 text-[13px] text-ink-3">
          Сопоставление: id → штрихкод → артикул. Название — только подсказка, нужна ваша проверка. Из KiT Shop ничего не удаляется.
          {data && ` Источник: ${data.source === "mock" ? "тренировочный каталог (MOCK)" : "KiT Shop"}, товаров в каталоге KiT Shop: ${data.catalogSize}.`}
        </p>

        {h && (
          <section className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            <Stat label="Всего блюд" v={h.total} />
            <Stat label="Сопоставлено" v={h.mapped} good />
            <Stat label="Нужна привязка" v={h.mappingRequired} bad={h.mappingRequired > 0} />
            <Stat label="Неоднозначно" v={h.ambiguous} bad={h.ambiguous > 0} />
            <Stat label="Без штрихкода" v={h.missingBarcode} bad={h.missingBarcode > 0} />
            <Stat label="Дубли штрихкодов" v={h.duplicateBarcodes.length} bad={h.duplicateBarcodes.length > 0} />
            <Stat label="Скрыто локально" v={h.inactive} />
          </section>
        )}
        {h && (
          <p className="mt-2 text-[12px] text-ink-3">
            CATALOG HEALTH: по штрихкоду {h.byBarcode} · по артикулу {h.byVendorCode} · вручную {h.manual}
            {h.duplicateBarcodes.length > 0 && ` · дубли: ${h.duplicateBarcodes.slice(0, 5).join(", ")}`}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {(["problems", "all"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={clsx("h-10 rounded-lg px-4 text-[14px]", filter === f ? "bg-ink text-bg" : "bg-surface-2 text-ink-2")}>
              {f === "problems" ? "Требуют внимания" : "Все"}
            </button>
          ))}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск: название, штрихкод, SKU" className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-[14px] outline-none focus:border-accent" />
        </div>
        {msg && <p className={clsx("mt-3 rounded-lg px-3 py-2 text-[13px]", msg.startsWith("✓") ? "bg-good/15 text-good-ink" : "bg-crit/15 text-crit-ink")}>{msg}</p>}

        <div className="mt-4 space-y-2">
          {!data ? (
            <div className="card p-6 text-ink-3">Загрузка…</div>
          ) : rows.length === 0 ? (
            <div className="card p-6 text-center text-ink-3">{filter === "problems" ? "Все блюда сопоставлены с KiT Shop ✓" : "Ничего не найдено"}</div>
          ) : (
            rows.map((r) => (
              <div key={r.id} className={clsx("card p-4", r.inactive && "opacity-60")}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[15px] font-semibold">{r.name}</div>
                    <div className="text-[12px] text-ink-3">
                      {r.sku} · {r.barcode ?? "без штрихкода"} · {r.price} ₸ {r.inactive && "· скрыт в Apps Холодосов"}
                    </div>
                  </div>
                  <div className="text-right text-[13px]">
                    {r.status === "MAPPED" ? (
                      <span className="text-good-ink">
                        KiT Shop #{r.kitshopProductId} · {MATCHED[r.matchedBy ?? ""]}
                      </span>
                    ) : (
                      <span className="text-warn">{REASON[r.reason ?? ""] ?? "нужна привязка"}</span>
                    )}
                  </div>
                </div>

                {r.suggestions.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[12px] text-ink-3">{r.reason === "ambiguous" ? "Совпадения — выберите правильный товар:" : "Похожие товары в KiT Shop (проверьте, это может быть другое блюдо):"}</div>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {r.suggestions.map((s) => (
                        <button
                          key={s.productId}
                          disabled={busy === r.id}
                          onClick={() => {
                            if (confirm(`Привязать «${r.name}» к товару KiT Shop «${s.name}» (#${s.productId})?`)) post(r.id, { action: "confirm-mapping", productId: r.id, kitshopProductId: s.productId });
                          }}
                          className="rounded-lg bg-surface-2 px-3 py-2 text-left text-[13px] active:bg-surface-3"
                        >
                          {s.name} <span className="text-ink-3">#{s.productId} · {s.barcode ?? "—"}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  {!readOnly && r.status !== "MAPPED" && r.reason !== "ambiguous" && (
                    <button
                      disabled={busy === r.id}
                      onClick={async () => {
                        const res = (await post(r.id, { action: "create-in-kitshop", productId: r.id, preview: true })) as unknown as Preview | null;
                        if (res) setPreview({ row: r, p: res });
                      }}
                      className="h-9 rounded-lg bg-accent/20 px-3 text-[13px] font-semibold text-accent"
                    >
                      СОЗДАТЬ В KITSHOP…
                    </button>
                  )}
                  <button
                    disabled={busy === r.id}
                    onClick={() => {
                      const id = prompt(`ProductId товара в KiT Shop для «${r.name}» (цифры):`, r.kitshopProductId ?? "");
                      if (id && /^\d+$/.test(id.trim())) post(r.id, { action: "confirm-mapping", productId: r.id, kitshopProductId: id.trim() });
                    }}
                    className="h-9 rounded-lg bg-surface-2 px-3 text-[13px]"
                  >
                    Указать ProductId
                  </button>
                  <button
                    disabled={busy === r.id}
                    onClick={() => post(r.id, { action: "deactivate", productId: r.id, inactive: !r.inactive })}
                    className="h-9 rounded-lg bg-surface-2 px-3 text-[13px] text-ink-3"
                  >
                    {r.inactive ? "Вернуть в Apps Холодосов" : "Деактивировать локально"}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={() => setPreview(null)}>
          <div className="card w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()}>
            <div className="text-[18px] font-bold">Создать в KiT Shop: {preview.row.name}</div>
            <div className="mt-1 text-[13px] text-ink-3">
              Режим: {preview.p.mode === "live" ? "РЕАЛЬНЫЙ KiT Shop" : preview.p.mode === "dry-run" ? "DRY-RUN (только журнал)" : "MOCK (тренировочный каталог)"} · метод {preview.p.method}
            </div>
            <pre className="mt-3 max-h-60 overflow-auto rounded-lg bg-surface-2 p-3 text-[12px]">{JSON.stringify(preview.p.body, null, 2)}</pre>
            {preview.p.notes.map((n) => (
              <p key={n} className="mt-2 text-[13px] text-warn">
                {n}
              </p>
            ))}
            <div className="mt-4 flex gap-2">
              <button
                disabled={busy === preview.row.id}
                onClick={async () => {
                  const res = await post(preview.row.id, { action: "create-in-kitshop", productId: preview.row.id, preview: false });
                  setPreview(null);
                  if (res) setMsg(`✓ ${String((res as { message?: string }).message ?? "Готово")}`);
                }}
                className="h-11 flex-1 rounded-lg bg-accent text-[14px] font-bold text-bg disabled:opacity-40"
              >
                СОЗДАТЬ
              </button>
              <button onClick={() => setPreview(null)} className="h-11 rounded-lg bg-surface-2 px-4 text-[14px]">
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}

function Stat({ label, v, good, bad }: { label: string; v: number; good?: boolean; bad?: boolean }) {
  return (
    <div className={clsx("card px-3 py-2", bad && "border-warn/50")}>
      <div className={clsx("num text-[22px] font-bold", good && "text-good-ink", bad && "text-warn")}>{v}</div>
      <div className="text-[11px] text-ink-3">{label}</div>
    </div>
  );
}
