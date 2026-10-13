"use client";

import clsx from "clsx";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MobileShell } from "@/components/mobile/MobileShell";
import { SkeletonList } from "@/components/mobile/ui";
import { OpRow } from "@/components/mobile/ops";
import { api, atLeast, useFlags, useMe } from "@/lib/client/api";
import { ReadOnlyNotice } from "@/components/mobile/ReadOnlyNotice";
import { MODE_NOTE, opAction, useOps, type OpView, type OpsList } from "@/lib/client/ops";

/**
 * СИНХРОНИЗАЦИЯ — KiT Shop operations journal.
 * Managers: every operation; check UNKNOWN ones (read-only), re-send FAILED / waiting ones, decide REQUIRES_REVIEW.
 * Employees: their own operations.
 */
export default function SyncPage() {
  const { readOnly } = useFlags();
  if (readOnly) return <ReadOnlyNotice title="Операции KiT Shop" />;
  return <SyncJournal />;
}

function SyncJournal() {
  const { data: me } = useMe();
  const manager = atLeast(me, "MANAGER");
  const [tab, setTab] = useState<"open" | "all">("open");
  const ops = useOps({ status: tab === "open" ? "open" : undefined });
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(null);
      qc.invalidateQueries({ queryKey: ["ops"] });
    }
  }

  const actions = (op: OpView) => {
    const btn = (label: string, fn: () => Promise<unknown>, tone = "bg-surface-3") => (
      <button key={label} disabled={busy === op.id} onClick={() => run(op.id, fn)} className={clsx("h-11 rounded-xl px-4 text-[14px] font-semibold disabled:opacity-40", tone)}>
        {busy === op.id ? "…" : label}
      </button>
    );
    const out = [];
    if (op.status === "UNKNOWN" || op.status === "REQUIRES_REVIEW" || op.status === "PENDING") out.push(btn("ПРОВЕРИТЬ В KITSHOP", () => opAction(op.id, { action: "verify" })));
    if (manager && (op.status === "FAILED" || op.status === "WAITING_FOR_CONNECTION") && op.errorCode !== "MAPPING_REQUIRED")
      out.push(btn("ОТПРАВИТЬ ПОВТОРНО", () => opAction(op.id, { action: "retry" }), "bg-accent/20 text-accent"));
    if (manager && (op.status === "UNKNOWN" || op.status === "REQUIRES_REVIEW")) {
      out.push(
        btn("ЕСТЬ В КАБИНЕТЕ ✓", async () => {
          if (confirm("Вы проверили в кабинете KiT Shop, что операция проведена?")) await opAction(op.id, { action: "resolve", decision: "confirmed" });
        }),
      );
      out.push(
        btn("НЕ ПРОВЕДЕНА ✕", async () => {
          if (confirm("Вы проверили в кабинете KiT Shop, что операции НЕТ? После этого её можно отправить повторно.")) await opAction(op.id, { action: "resolve", decision: "failed" });
        }),
      );
    }
    return out.length ? out : undefined;
  };

  return (
    <MobileShell title={manager ? "Синхронизация" : "Мои операции"} back="/m">
      {ops.data && <Summary data={ops.data} />}
      <div className="mt-3 grid grid-cols-2 gap-1 rounded-2xl bg-surface-2 p-1">
        {(["open", "all"] as const).map((x) => (
          <button key={x} onClick={() => setTab(x)} className={clsx("h-11 rounded-xl text-[14px] font-semibold", tab === x ? "bg-ink text-bg" : "text-ink-2")}>
            {x === "open" ? "Требуют внимания" : "Все"}
          </button>
        ))}
      </div>
      {manager && (
        <button
          disabled={busy === "all"}
          onClick={() => run("all", () => api("/api/ops?sync=1"))}
          className="mt-3 h-12 w-full rounded-xl bg-surface-2 text-[14px] font-semibold text-accent disabled:opacity-40"
        >
          {busy === "all" ? "Проверяем…" : "↻ Проверить всё и отправить ожидающие"}
        </button>
      )}
      {message && <p className="mt-2 rounded-xl bg-crit/15 px-3 py-2 text-[13px] text-crit-ink">{message}</p>}
      <div className="mt-3 space-y-2">
        {!ops.data ? (
          <SkeletonList />
        ) : ops.data.operations.length === 0 ? (
          <div className="card p-6 text-center text-[15px] text-ink-3">{tab === "open" ? "Все операции подтверждены ✓" : "Операций пока нет"}</div>
        ) : (
          ops.data.operations.map((op) => <OpRow key={op.id} op={op} actions={actions(op)} />)
        )}
      </div>
    </MobileShell>
  );
}

function Summary({ data }: { data: OpsList }) {
  const c = data.counts;
  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        <Cell n={c.unknown} label="проверить" tone={c.unknown > 0} />
        <Cell n={c.waiting} label="ждут связи" tone={c.waiting > 0} />
        <Cell n={c.failed} label="ошибки" tone={c.failed > 0} />
      </div>
      <p className="mt-2 px-1 text-[12px] text-ink-3">
        {data.write.liveShops.length ? `KiT Shop: запись включена для ${data.write.liveShops.length} точ.; остальные — ${data.write.defaultMode}.` : MODE_NOTE[data.write.defaultMode]}
      </p>
    </>
  );
}

function Cell({ n, label, tone }: { n: number; label: string; tone?: boolean }) {
  return (
    <div className={clsx("card px-3 py-3", tone && "border-warn/50")}>
      <div className="num text-[24px] font-bold leading-none">{n}</div>
      <div className="mt-1 text-[12px] text-ink-3">{label}</div>
    </div>
  );
}
