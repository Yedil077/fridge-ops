"use client";

import Link from "next/link";
import clsx from "clsx";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { MobileShell } from "@/components/mobile/MobileShell";
import { SkeletonList } from "@/components/mobile/ui";
import { ScannerSheet, SendStatusPanel, fmtTime, type SendState } from "@/components/mobile/ops";
import { atLeast, useMe } from "@/lib/client/api";
import { useMobileFridges } from "@/lib/client/mobileApi";
import { MODE_NOTE, newOperationId, submitOperation, useOpsCatalog, type OpType, type OpView, type OpsCatalog } from "@/lib/client/ops";

const TYPES: { id: OpType; label: string; verb: string }[] = [
  { id: "LOAD", label: "Загрузка", verb: "ЗАГРУЗКУ" },
  { id: "UNLOAD", label: "Разгрузка", verb: "РАЗГРУЗКУ" },
  { id: "WRITE_OFF", label: "Списание", verb: "СПИСАНИЕ" },
];
const REASONS = ["Истёк срок", "Повреждена упаковка", "Брак", "Другое"];
const LAST_FRIDGE = "fo-scan-fridge";
const draftKey = (f: string, t: OpType) => `fo-opdraft-${f}-${t}`;

function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeLS(key: string, v: unknown) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

export default function ScanPage() {
  return (
    <Suspense fallback={<MobileShell title="Сканирование"><SkeletonList /></MobileShell>}>
      <Scan />
    </Suspense>
  );
}

type Product = OpsCatalog["products"][number];

function Scan() {
  const params = useSearchParams();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const fridges = useMobileFridges();
  const [fridgeId, setFridgeId] = useState<string | null>(params.get("fridge"));
  const [type, setType] = useState<OpType>((["LOAD", "UNLOAD", "WRITE_OFF"].includes(params.get("type") ?? "") ? params.get("type") : "LOAD") as OpType);
  const cat = useOpsCatalog(fridgeId);
  const [items, setItems] = useState<Record<string, number>>({});
  const [reason, setReason] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(false);
  const [rapid, setRapid] = useState(true);
  const [lastScan, setLastScan] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [send, setSend] = useState<SendState>({ phase: "idle" });
  /** operation_uuid of the batch being sent — reused by any repeated tap */
  const pendingId = useRef<string | null>(null);

  useEffect(() => {
    // once on open: continue with the last fridge ("Сменить холодильник" clears it on purpose)
    if (!params.get("fridge")) setFridgeId(readLS<string | null>(LAST_FRIDGE, null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!fridgeId) return;
    writeLS(LAST_FRIDGE, fridgeId);
    setItems(readLS(draftKey(fridgeId, type), {}));
    pendingId.current = null;
  }, [fridgeId, type]);

  const products = useMemo(() => cat.data?.products ?? [], [cat.data]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const limitOf = useCallback((p: Product) => (type === "LOAD" ? 500 : Math.max(0, p.stock)), [type]);

  const change = useCallback(
    (id: string, qty: number) => {
      setItems((cur) => {
        const next = { ...cur };
        if (qty <= 0) delete next[id];
        else next[id] = qty;
        if (fridgeId) writeLS(draftKey(fridgeId, type), next);
        return next;
      });
      pendingId.current = null; // a changed batch is a new operation
    },
    [fridgeId, type],
  );

  const add = useCallback(
    (p: Product) => {
      if (!p.mapped) {
        setNotice(`«${p.name}» не сопоставлен с KiT Shop — операция с ним невозможна.`);
        return false;
      }
      const cur = items[p.id] ?? 0;
      if (cur + 1 > limitOf(p)) {
        setNotice(`«${p.name}»: в холодильнике только ${p.stock} шт.`);
        return false;
      }
      change(p.id, cur + 1);
      return true;
    },
    [items, change, limitOf],
  );

  const onCode = useCallback(
    (code: string) => {
      const p = products.find((x) => x.barcode === code.trim()) ?? products.find((x) => x.sku === code.trim());
      if (!p) {
        setLastScan(null);
        setNotice(`Штрихкод ${code} не найден в базе товаров.`);
        if (!rapid) setScanning(false);
        return;
      }
      if (add(p)) setLastScan(`${p.name} · ${(items[p.id] ?? 0) + 1}`);
      if (!rapid) setScanning(false);
    },
    [products, add, items, rapid],
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return products.filter((p) => p.name.toLowerCase().includes(q) || (p.barcode ?? "").startsWith(q) || p.sku.toLowerCase().includes(q)).slice(0, 20);
  }, [products, query]);

  const chosen = Object.entries(items)
    .map(([id, qty]) => ({ p: byId.get(id), qty }))
    .filter((x): x is { p: Product; qty: number } => !!x.p && x.qty > 0);
  const units = chosen.reduce((a, x) => a + x.qty, 0);
  const t = TYPES.find((x) => x.id === type)!;

  async function confirmSend() {
    if (!fridgeId || !chosen.length) return;
    if (type === "WRITE_OFF" && !reason) {
      setNotice("Выберите причину списания.");
      return;
    }
    pendingId.current ??= newOperationId();
    setConfirming(false);
    setSend({ phase: "sending", startedAt: Date.now() });
    const res = await submitOperation({
      id: pendingId.current,
      type,
      fridgeId,
      items: chosen.map((x) => ({ productId: x.p.id, qty: x.qty })),
      reason: type === "WRITE_OFF" ? (reason ?? undefined) : undefined,
    });
    if (res.kind === "answer") setSend({ phase: "answer", op: res.op });
    else if (res.kind === "queued") setSend({ phase: "queued" });
    else setSend({ phase: "error", message: res.message, code: res.code });
    // the operation exists now (or is safely queued): clear the draft so it is never sent as a new one
    if (res.kind === "queued" || (res.kind === "answer" && res.op.status !== "FAILED")) {
      writeLS(draftKey(fridgeId, type), null);
      setItems({});
      setReason(null);
      pendingId.current = null;
    }
    if (res.kind === "answer" && res.op.status === "FAILED") pendingId.current = null; // definitely not applied
    qc.invalidateQueries({ queryKey: ["ops"] });
    qc.invalidateQueries({ queryKey: ["m"] });
  }

  const onUpdate = useCallback(
    (op: OpView) => {
      setSend({ phase: "answer", op });
      if (op.status === "CONFIRMED") qc.invalidateQueries({ queryKey: ["ops"] });
    },
    [qc],
  );

  // ── step 1: fridge ──
  if (!fridgeId)
    return (
      <MobileShell title="Сканирование" back="/m">
        <h2 className="label mb-2 px-1">Выберите холодильник</h2>
        {!fridges.data ? (
          <SkeletonList />
        ) : (
          <div className="space-y-2">
            {fridges.data.fridges.map((f) => (
              <button key={f.id} onClick={() => setFridgeId(f.id)} className="card flex min-h-14 w-full items-center justify-between px-4 py-3 text-left active:bg-surface-2">
                <span className="text-[16px] font-semibold">{f.name}</span>
                <span className="num text-[14px] text-ink-3">{f.totalStock} шт</span>
              </button>
            ))}
          </div>
        )}
      </MobileShell>
    );

  return (
    <MobileShell title={cat.data?.fridge?.name ?? "Сканирование"} back="/m" now={cat.data?.now}>
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => setFridgeId(null)} className="text-[14px] text-accent">
          Сменить холодильник
        </button>
        {cat.data && (
          <span className="text-[12px] text-ink-3">
            остатки на {fmtTime(cat.data.stockSyncedAt)}{" "}
            <button onClick={() => cat.refetch()} className="ml-1 font-semibold text-accent">
              {cat.isFetching ? "…" : "ОБНОВИТЬ"}
            </button>
          </span>
        )}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-1 rounded-2xl bg-surface-2 p-1">
        {TYPES.map((x) => (
          <button key={x.id} onClick={() => setType(x.id)} className={clsx("h-11 rounded-xl text-[14px] font-semibold", type === x.id ? "bg-ink text-bg" : "text-ink-2")}>
            {x.label}
          </button>
        ))}
      </div>
      {type === "WRITE_OFF" && <p className="mt-2 px-1 text-[12px] text-ink-3">В KiT Shop списание проводится как разгрузка с пометкой «СПИСАНИЕ» и причиной.</p>}
      {cat.data && cat.data.write.defaultMode !== "live" && cat.data.write.liveShops.length === 0 && (
        <p className="mt-2 rounded-xl bg-accent/10 px-3 py-2 text-[12px] text-accent">{MODE_NOTE[cat.data.write.defaultMode]}</p>
      )}

      <div className="mt-4 flex gap-2">
        <button onClick={() => { setLastScan(null); setScanning(true); }} className="flex h-14 flex-1 items-center justify-center gap-2 rounded-2xl bg-ink text-[17px] font-bold text-bg">
          📷 СКАНИРОВАТЬ
        </button>
        <button
          onClick={() => setRapid(!rapid)}
          className={clsx("h-14 rounded-2xl px-3 text-[12px] font-semibold leading-tight", rapid ? "bg-accent/20 text-accent" : "bg-surface-2 text-ink-3")}
        >
          быстрый
          <br />
          режим {rapid ? "вкл" : "выкл"}
        </button>
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Поиск: название, штрихкод или SKU"
        className="mt-3 h-12 w-full rounded-xl border border-line bg-surface px-4 text-[16px] outline-none focus:border-accent"
      />
      {notice && (
        <button onClick={() => setNotice(null)} className="mt-2 block w-full rounded-xl bg-warn/15 px-3 py-2 text-left text-[13px] text-warn">
          {notice} ✕
        </button>
      )}
      {results.length > 0 && (
        <div className="mt-2 space-y-1">
          {results.map((p) => (
            <button key={p.id} onClick={() => add(p)} className="card flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left active:bg-surface-2">
              <span className="min-w-0">
                <span className="block truncate text-[15px]">{p.name}</span>
                <span className="text-[12px] text-ink-3">
                  {p.sku} · {p.barcode ?? "без штрихкода"} · в холодильнике {p.stock}
                </span>
              </span>
              {p.mapped ? <span className="shrink-0 text-[22px] text-accent">＋</span> : <span className="shrink-0 text-[11px] text-warn">нет в KiT Shop</span>}
            </button>
          ))}
        </div>
      )}

      <h2 className="label mb-2 mt-5 px-1">
        {t.label}: {units} шт
      </h2>
      {!cat.data ? (
        <SkeletonList />
      ) : chosen.length === 0 ? (
        <div className="card p-5 text-center text-[14px] text-ink-3">Сканируйте товары или найдите их поиском.</div>
      ) : (
        <div className="space-y-2">
          {chosen.map(({ p, qty }) => (
            <div key={p.id} className="card flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold">{p.name}</div>
                <div className="text-[12px] text-ink-3">
                  {p.sku} · было {p.stock} → станет {type === "LOAD" ? p.stock + qty : Math.max(0, p.stock - qty)}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => change(p.id, qty - 1)} className="h-11 w-11 rounded-xl bg-surface-3 text-[22px]" aria-label="Меньше">
                  −
                </button>
                <span className="num w-8 text-center text-[20px] font-bold">{qty}</span>
                <button onClick={() => change(p.id, Math.min(limitOf(p), qty + 1))} disabled={qty >= limitOf(p)} className="h-11 w-11 rounded-xl bg-surface-3 text-[22px] disabled:opacity-30" aria-label="Больше">
                  +
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {type === "WRITE_OFF" && chosen.length > 0 && (
        <div className="mt-4">
          <div className="label mb-2 px-1">Причина списания</div>
          <div className="flex flex-wrap gap-2">
            {REASONS.map((r) => (
              <button key={r} onClick={() => setReason(r)} className={clsx("h-11 rounded-xl px-4 text-[14px]", reason === r ? "bg-ink text-bg" : "bg-surface-2 text-ink-2")}>
                {r}
              </button>
            ))}
          </div>
        </div>
      )}

      <Link href="/m/sync" className="mt-6 block py-2 text-center text-[14px] text-ink-3">
        Журнал операций ›
      </Link>

      {chosen.length > 0 && (
        <div className="fixed inset-x-0 bottom-[calc(64px+env(safe-area-inset-bottom))] z-20 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur">
          <button onClick={() => setConfirming(true)} className="mx-auto flex h-14 w-full max-w-xl items-center justify-center rounded-2xl bg-accent text-[17px] font-bold text-bg">
            ПОДТВЕРДИТЬ {t.verb} · {units} шт
          </button>
        </div>
      )}

      {confirming && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/60" onClick={() => setConfirming(false)}>
          <div className="w-full rounded-t-3xl bg-surface px-5 pt-5 pb-[calc(20px+env(safe-area-inset-bottom))]" onClick={(e) => e.stopPropagation()}>
            <div className="text-[19px] font-bold">
              {t.label} · {cat.data?.fridge?.name}
            </div>
            <div className="mt-1 text-[13px] text-ink-3">Будет отправлено в KiT Shop (ShopId {cat.data?.fridge?.shopId}). Количество — только то, что вы отметили.</div>
            <div className="mt-3 max-h-[40vh] space-y-1 overflow-y-auto">
              {chosen.map(({ p, qty }) => (
                <div key={p.id} className="flex justify-between gap-2 text-[15px]">
                  <span className="truncate">{p.name}</span>
                  <span className="num shrink-0 font-semibold">
                    {type === "LOAD" ? "+" : "−"}
                    {qty}
                  </span>
                </div>
              ))}
            </div>
            {type === "WRITE_OFF" && <div className="mt-2 text-[14px] text-ink-2">Причина: {reason ?? "не выбрана"}</div>}
            <button onClick={confirmSend} className="mt-5 h-14 w-full rounded-2xl bg-accent text-[17px] font-bold text-bg">
              ОТПРАВИТЬ · {units} шт
            </button>
            <button onClick={() => setConfirming(false)} className="mt-2 h-12 w-full text-[15px] text-ink-3">
              Отмена
            </button>
          </div>
        </div>
      )}

      {scanning && <ScannerSheet rapid={rapid} onCode={onCode} onClose={() => setScanning(false)} lastLabel={lastScan} />}
      <SendStatusPanel state={send} onClose={() => setSend({ phase: "idle" })} onUpdate={onUpdate} isAdmin={atLeast(me, "ADMIN")} />
    </MobileShell>
  );
}
