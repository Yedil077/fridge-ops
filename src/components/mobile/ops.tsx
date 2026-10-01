"use client";

import Link from "next/link";
import clsx from "clsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BrowserScanner } from "@/lib/client/scanner";
import { getOp, MODE_NOTE, opAction, STATUS_TONE, useOps, type OpView } from "@/lib/client/ops";

// ───────────────────────── camera scanner ─────────────────────────

/**
 * Full-screen camera scanner (Web BarcodeDetector — Chrome / Android WebView).
 * rapid = keeps scanning: every new scan adds +1 (the same code is ignored for 1.5 s).
 */
export function ScannerSheet({ rapid, onCode, onClose, lastLabel }: { rapid: boolean; onCode: (code: string) => void; onClose: () => void; lastLabel?: string | null }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    const scanner = new BrowserScanner();
    let stream: MediaStream | null = null;
    let stopped = false;
    let last = { code: "", at: 0 };
    (async () => {
      if (!(await scanner.isAvailable())) {
        setError("Сканер недоступен на этом устройстве. Используйте поиск по названию, штрихкоду или SKU.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      } catch {
        setError("Нет доступа к камере. Разрешите камеру в настройках телефона или используйте поиск.");
        return;
      }
      if (stopped || !video.current) return;
      video.current.srcObject = stream;
      await video.current.play().catch(() => undefined);
      while (!stopped) {
        try {
          const code = video.current ? await scanner.scanFrom(video.current) : null;
          const now = Date.now();
          if (code && (code !== last.code || now - last.at > 1500)) {
            last = { code, at: now };
            navigator.vibrate?.(60);
            onCodeRef.current(code);
            if (!rapid) break;
          }
        } catch {
          /* frame not ready */
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    return () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [rapid]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <div className="flex h-14 items-center justify-between px-4">
        <span className="text-[15px] font-semibold text-white">{rapid ? "Быстрое сканирование" : "Сканирование"}</span>
        <button onClick={onClose} className="h-11 rounded-xl bg-white/15 px-4 text-[15px] font-semibold text-white">
          ГОТОВО
        </button>
      </div>
      <div className="relative flex-1">
        {error ? (
          <p className="px-6 pt-16 text-center text-[16px] text-white/80">{error}</p>
        ) : (
          <>
            <video ref={video} playsInline muted className="h-full w-full object-cover" />
            <div className="pointer-events-none absolute inset-x-10 top-1/2 h-40 -translate-y-1/2 rounded-2xl border-2 border-white/70" />
          </>
        )}
      </div>
      {lastLabel && <div className="bg-good/90 px-4 py-3 text-center text-[16px] font-semibold text-white">✓ {lastLabel}</div>}
    </div>
  );
}

// ───────────────────────── send status (synchronous confirm UX) ─────────────────────────

export type SendState =
  | { phase: "idle" }
  | { phase: "sending"; startedAt: number }
  | { phase: "answer"; op: OpView }
  | { phase: "queued" }
  | { phase: "error"; message: string; code?: string };

/**
 * 0–3 s "Отправляем…", 3–10 s "KiT Shop отвечает медленнее обычного…", then the server answers
 * CONFIRMED / FAILED / UNKNOWN ("Статус операции проверяется" — we keep checking, never re-send).
 * Success is shown ONLY for a CONFIRMED answer.
 */
export function SendStatusPanel({ state, onClose, onUpdate, isAdmin }: { state: SendState; onClose: () => void; onUpdate: (op: OpView) => void; isAdmin?: boolean }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (state.phase !== "sending") return;
    const t = setInterval(() => force((x) => x + 1), 500);
    return () => clearInterval(t);
  }, [state.phase]);

  // UNKNOWN → poll the server; it verifies through KiT Shop read methods (never re-sends)
  const opId = state.phase === "answer" ? state.op.id : null;
  const opStatus = state.phase === "answer" ? state.op.status : null;
  useEffect(() => {
    if (!opId || (opStatus !== "UNKNOWN" && opStatus !== "PENDING")) return;
    let n = 0;
    const t = setInterval(async () => {
      n++;
      try {
        const res = n % 2 === 0 ? await opAction(opId, { action: "verify" }) : await getOp(opId);
        onUpdate(res.operation);
      } catch {
        /* offline — keep waiting */
      }
      if (n >= 12) clearInterval(t);
    }, 5_000);
    return () => clearInterval(t);
  }, [opId, opStatus, onUpdate]);

  if (state.phase === "idle") return null;
  let icon = "⏳";
  let title = "";
  let body: string | null = null;
  let tone = "border-line-strong";
  let done = false;
  let extra: ReactNode = null;

  if (state.phase === "sending") {
    const s = (Date.now() - state.startedAt) / 1000;
    title = s < 3 ? "Отправляем в KiT Shop…" : "KiT Shop отвечает медленнее обычного…";
    body = s < 3 ? null : "Не закрывайте экран и не нажимайте повторно — операция не задвоится.";
  } else if (state.phase === "queued") {
    icon = "📶";
    title = "Нет связи — операция сохранена на телефоне";
    body = "Отправим один раз, когда появится связь. Статус: ждёт связи.";
    tone = "border-warn/50";
    done = true;
  } else if (state.phase === "error") {
    icon = "⚠";
    title = state.code === "MAPPING_REQUIRED" ? "Товар не сопоставлен с KiT Shop" : "Операция не создана";
    body = state.message;
    tone = "border-crit/50";
    done = true;
    if (state.code === "MAPPING_REQUIRED")
      extra = isAdmin ? <Link href="/admin/products" className="mt-3 block text-[15px] text-accent">Открыть сопоставление товаров ›</Link> : <p className="mt-2 text-[13px] text-ink-3">Сообщите администратору.</p>;
  } else {
    const op = state.op;
    done = op.status !== "PENDING";
    if (op.status === "CONFIRMED") {
      icon = "✓";
      title = `${op.typeLabel} подтверждена`;
      body = `${op.fridgeName}: ${op.units} шт. ${MODE_NOTE[op.adapterMode]}`;
      tone = "border-good/60";
    } else if (op.status === "FAILED") {
      icon = "✕";
      title = "KiT Shop не принял операцию";
      body = op.error;
      tone = "border-crit/50";
      if (op.errorCode === "NOT_IN_SHOP_BASE")
        extra = isAdmin ? (
          <Link href="/admin/products" className="mt-3 flex h-12 items-center justify-center rounded-xl bg-surface-3 text-[15px] font-bold">
            ДОБАВИТЬ В БАЗУ
          </Link>
        ) : (
          <p className="mt-2 text-[13px] text-ink-3">Товара нет в базе этой точки — сообщите администратору.</p>
        );
    } else if (op.status === "UNKNOWN" || op.status === "PENDING") {
      icon = "🔎";
      title = "Статус операции проверяется";
      body = "Ответ KiT Shop не получен. Мы проверяем, прошла ли операция. Повторно не отправляем — товар не задвоится.";
      tone = "border-warn/50";
    } else if (op.status === "REQUIRES_REVIEW") {
      icon = "👀";
      title = "Нужна проверка менеджером";
      body = "Автоматически подтвердить не удалось. Менеджер проверит в кабинете KiT Shop (экран «Синхронизация»).";
      tone = "border-warn/50";
    } else if (op.status === "WAITING_FOR_CONNECTION") {
      icon = "📶";
      title = "KiT Shop недоступен — ждёт связи";
      body = "Операция не отправлялась. Отправим один раз автоматически, когда связь с KiT Shop восстановится.";
      tone = "border-warn/50";
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/60 backdrop-blur-sm">
      <div className={clsx("w-full rounded-t-3xl border-t-2 bg-surface px-5 pt-6 pb-[calc(20px+env(safe-area-inset-bottom))]", tone)}>
        <div className="flex items-start gap-3">
          <span className={clsx("text-[30px] leading-none", state.phase === "sending" && "animate-pulse")}>{icon}</span>
          <div className="min-w-0 flex-1">
            <div className="text-[19px] font-bold leading-snug">{title}</div>
            {body && <p className="mt-1 text-[15px] text-ink-2">{body}</p>}
            {extra}
          </div>
        </div>
        {done && (
          <button onClick={onClose} className="mt-5 h-14 w-full rounded-2xl bg-ink text-[17px] font-bold text-bg">
            OK
          </button>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── journal row ─────────────────────────

export function OpRow({ op, actions }: { op: OpView; actions?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card p-4">
      <button onClick={() => setOpen(!open)} className="block w-full text-left">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[15px] font-semibold">
            {op.typeLabel} · {op.fridgeName}
          </span>
          <span className={clsx("shrink-0 text-[13px] font-semibold", STATUS_TONE[op.status])}>{op.statusLabel}</span>
        </div>
        <div className="mt-1 text-[13px] text-ink-3">
          {op.units} шт · {op.lines.length} поз. · {op.createdBy} · {fmtTime(op.createdAt)}
          {op.transferRole && ` · перенос (${op.transferRole === "source" ? "разгрузка источника" : "загрузка цели"})`}
          {op.adapterMode !== "live" && ` · ${op.adapterMode === "mock" ? "ТЕСТ" : "DRY-RUN"}`}
        </div>
        {op.error && op.status !== "CONFIRMED" && <div className="mt-1 text-[13px] text-warn">{op.error}</div>}
      </button>
      {open && (
        <div className="mt-3 space-y-1 border-t border-line pt-3 text-[13px]">
          {op.lines.map((l) => (
            <div key={l.productId} className="flex justify-between gap-2">
              <span className="truncate">{l.name}</span>
              <span className="num shrink-0">
                {op.type === "LOAD" ? "+" : "−"}
                {l.qty} · KS {l.kitshopProductId}
              </span>
            </div>
          ))}
          {op.reason && <div className="text-ink-3">Причина: {op.reason}</div>}
          <div className="pt-2 text-ink-3">
            id {op.id} · попыток {op.attempts}
            {op.kitshopFillupId && ` · FillupId ${op.kitshopFillupId}`}
          </div>
          {op.history.map((h, i) => (
            <div key={i} className="text-ink-3">
              {fmtTime(h.at)} · {h.status} · {h.note}
            </div>
          ))}
        </div>
      )}
      {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function fmtTime(ms: number) {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

// ───────────────────────── mission → KiT Shop transfer legs ─────────────────────────

/** TRANSFER = source UNLOAD + target LOAD(s). Each leg is tracked separately; shown after a mission. */
export function MissionKitShopStatus({ missionId }: { missionId: string }) {
  const { data } = useOps({ missionId });
  const legs = data?.operations ?? [];
  if (!legs.length) return null;
  const sorted = [...legs].sort((a, b) => (a.transferRole === "source" ? -1 : b.transferRole === "source" ? 1 : 0));
  const all = legs.every((o) => o.status === "CONFIRMED");
  return (
    <div className="card mt-4 p-4 text-left">
      <div className="label mb-2">KiT Shop · перенос</div>
      <div className="space-y-1.5">
        {sorted.map((o) => (
          <div key={o.id} className="flex items-center justify-between gap-2 text-[14px]">
            <span className="truncate">
              {o.transferRole === "source" ? "Разгрузка" : "Загрузка"} · {o.fridgeName} · {o.units} шт
            </span>
            <span className={clsx("shrink-0 text-[13px] font-semibold", STATUS_TONE[o.status])}>{o.statusLabel}</span>
          </div>
        ))}
      </div>
      {!all && <Link href="/m/sync" className="mt-2 block text-[13px] text-accent">Подробнее в журнале ›</Link>}
      {legs[0].adapterMode !== "live" && <div className="mt-2 text-[12px] text-ink-3">{MODE_NOTE[legs[0].adapterMode]}</div>}
    </div>
  );
}
