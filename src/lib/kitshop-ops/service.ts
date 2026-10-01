import {
  noteMarker,
  type AuditEntry,
  type KitShopWriteAdapter,
  type KsOperation,
  type OpErrorCode,
  type OpLine,
  type OpOrigin,
  type OpStatus,
  type OpType,
  type WriteOutcome,
} from "./types";

/**
 * Operations service: the ONLY way Fridge Ops writes to KiT Shop.
 *
 * Safety rules (spec §9–§12, audit §2.1):
 *  • idempotency: the client generates operation_uuid; a repeated submit with the same id returns the
 *    existing operation and NEVER sends again (double click, offline re-send, retry after reload);
 *  • success is shown only after KiT Shop answered OK (or verification found the operation);
 *  • no answer → UNKNOWN; it is never re-sent automatically, only verified through read methods;
 *  • only a provably unsent request (WAITING_FOR_CONNECTION) or a rejected one (FAILED) may be sent again;
 *  • TRANSFER = source UNLOAD + target LOAD, tracked separately; the LOAD waits for the UNLOAD;
 *  • every state change is written to the audit log.
 */

export interface OpsState {
  operations: KsOperation[];
  audit: AuditEntry[];
}

export interface OpsDeps {
  state: OpsState;
  adapterFor(shopId: string, origin?: OpOrigin): KitShopWriteAdapter;
  /** PAUSE ALL WRITES (server-side flag): nothing is handed to any adapter while true */
  isPaused?(): boolean;
  /** durable save — awaited before a LIVE send, so a crash can never lose the record of a sent write */
  flush?(): Promise<void>;
  /** wall-clock ms */
  now(): number;
  save(): void;
  newId(prefix: string): string;
  timeoutMs: number;
  /** may "not found in KiT Shop" be trusted as "not applied" for this adapter? (live: only after Phase D) */
  trustAbsent(mode: KsOperation["adapterMode"]): boolean;
  /** how long after sending an absent operation may still appear in KiT Shop */
  verifyWindowMs: number;
  onConfirmed?(op: KsOperation): void;
}

export interface SubmitInput {
  id: string;
  type: OpType;
  fridgeId: string;
  shopId: string;
  fridgeName: string;
  lines: OpLine[];
  reason?: string | null;
  missionId?: string | null;
  transferId?: string | null;
  transferRole?: "source" | "target" | null;
  dependsOn?: string | null;
  applyToSim?: boolean;
  origin?: OpOrigin;
}

/** MakeFillUp.Notes — starts with the FO:<uuid> marker used for reconciliation through GetFillUps. */
export function fillUpNotes(op: { id: string; type: OpType; reason?: string | null; missionId?: string | null }, user: string): string {
  return `${noteMarker(op.id)} ${op.type}${op.reason ? ` ${op.reason}` : ""}${op.missionId ? ` mission ${op.missionId}` : ""} by ${user}`.slice(0, 250);
}

export class OpsError extends Error {
  /** marker for duck typing: dev bundles may load this module twice, so `instanceof` is not reliable */
  readonly isOpsError = true;
  constructor(
    public status: number,
    public code: OpErrorCode | "INVALID" | "NOT_FOUND" | "CONFLICT",
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "OpsError";
  }
}

export const isOpsError = (e: unknown): e is OpsError => !!e && typeof e === "object" && (e as { isOpsError?: unknown }).isOpsError === true;

export interface TransferTarget {
  fridgeId: string;
  shopId: string;
  fridgeName: string;
  lines: OpLine[];
}

export interface TransferInput {
  missionId: string;
  source: { fridgeId: string; shopId: string; fridgeName: string };
  targets: TransferTarget[];
  applyToSim?: boolean;
}

export type TransferState = "NONE" | "IN_PROGRESS" | "CONFIRMED" | "PARTIAL" | "FAILED" | "ATTENTION";

const TIMEOUT = Symbol("timeout");

export class OpsService {
  constructor(private d: OpsDeps) {}

  get(id: string): KsOperation | undefined {
    return this.d.state.operations.find((o) => o.id === id);
  }

  list(filter: { status?: OpStatus[]; missionId?: string; user?: string; limit?: number } = {}): KsOperation[] {
    let ops = this.d.state.operations;
    if (filter.status) ops = ops.filter((o) => filter.status!.includes(o.status));
    if (filter.missionId) ops = ops.filter((o) => o.missionId === filter.missionId);
    if (filter.user) ops = ops.filter((o) => o.createdBy === filter.user);
    return ops.slice(-(filter.limit ?? 200)).reverse();
  }

  audit(user: string, action: string, entity: string, entityId: string, details: Record<string, unknown> = {}) {
    this.d.state.audit.push({ id: this.d.newId("A"), at: this.d.now(), user, action, entity, entityId, details });
  }

  /** Create + send. Idempotent by input.id. */
  async submit(input: SubmitInput, user: string): Promise<{ op: KsOperation; duplicate: boolean }> {
    const existing = this.get(input.id);
    if (existing) {
      this.audit(user, "op.duplicate_submit", "operation", existing.id, { status: existing.status });
      return { op: existing, duplicate: true };
    }
    this.assertNotPaused();
    this.validate(input);
    const now = this.d.now();
    const op: KsOperation = {
      id: input.id,
      type: input.type,
      fridgeId: input.fridgeId,
      shopId: input.shopId,
      fridgeName: input.fridgeName,
      lines: input.lines.map((l) => ({ ...l, qty: Math.round(l.qty) })),
      reason: input.reason?.slice(0, 120) ?? null,
      status: "DRAFT",
      errorCode: null,
      error: null,
      createdAt: now,
      createdBy: user,
      sentAt: null,
      attempts: 0,
      confirmedAt: null,
      kitshopFillupId: null,
      adapterMode: this.d.adapterFor(input.shopId, input.origin).mode,
      missionId: input.missionId ?? null,
      transferId: input.transferId ?? null,
      transferRole: input.transferRole ?? null,
      dependsOn: input.dependsOn ?? null,
      applyToSim: input.applyToSim ?? false,
      origin: input.origin ?? "app",
      history: [{ at: now, status: "DRAFT", note: "создано" }],
    };
    this.d.state.operations.push(op);
    this.audit(user, "op.create", "operation", op.id, {
      type: op.type,
      shopId: op.shopId,
      lines: op.lines.map((l) => ({ p: l.kitshopProductId, q: l.qty })),
      missionId: op.missionId,
    });
    this.d.save();
    await this.send(op, user);
    return { op, duplicate: false };
  }

  private assertNotPaused() {
    if (this.d.isPaused?.()) throw new OpsError(423, "WRITES_PAUSED", "Запись в KiT Shop приостановлена администратором (PAUSE ALL WRITES)");
  }

  private validate(input: SubmitInput) {
    if (!/^[A-Za-z0-9:_-]{8,80}$/.test(input.id)) throw new OpsError(400, "INVALID", "Некорректный идентификатор операции");
    if (!input.shopId) throw new OpsError(400, "INVALID", "У холодильника нет KiT Shop ShopId — операция невозможна");
    const lines = input.lines.filter((l) => l.qty > 0);
    if (!lines.length) throw new OpsError(400, "INVALID", "Нет позиций с количеством больше 0");
    if (input.lines.some((l) => !Number.isInteger(l.qty) || l.qty < 0 || l.qty > 500)) throw new OpsError(400, "INVALID", "Количество — целое число 0…500");
    const unmapped = input.lines.filter((l) => !l.kitshopProductId);
    if (unmapped.length)
      throw new OpsError(422, "MAPPING_REQUIRED", "Товар не сопоставлен с KiT Shop — нужна привязка", unmapped.map((l) => ({ productId: l.productId, name: l.name })));
    if (input.type === "WRITE_OFF" && !input.reason?.trim()) throw new OpsError(400, "INVALID", "Укажите причину списания");
    input.lines = lines;
  }

  private setStatus(op: KsOperation, status: OpStatus, note: string) {
    op.status = status;
    op.history.push({ at: this.d.now(), status, note: note.slice(0, 300) });
    if (op.history.length > 30) op.history.splice(1, op.history.length - 30);
  }

  /** Sends one operation. Precondition: it is DRAFT, FAILED (re-send by a person) or WAITING_FOR_CONNECTION. */
  private async send(op: KsOperation, user: string): Promise<void> {
    if (op.dependsOn) {
      const parent = this.get(op.dependsOn);
      if (parent?.status !== "CONFIRMED") {
        op.errorCode = "SOURCE_NOT_CONFIRMED";
        op.error = "Ждём подтверждения снятия в точке-источнике";
        if (op.status !== "DRAFT") this.setStatus(op, "DRAFT", op.error);
        this.d.save();
        return;
      }
    }
    if (this.d.isPaused?.()) {
      // blocked BEFORE anything reaches KiT Shop; stays where it is until writes are resumed
      op.errorCode = "WRITES_PAUSED";
      op.error = "Запись приостановлена (PAUSE ALL WRITES)";
      this.d.save();
      return;
    }
    const adapter = this.d.adapterFor(op.shopId, op.origin);
    op.adapterMode = adapter.mode;
    op.errorCode = null;
    op.error = null;
    op.sentAt = this.d.now();
    op.attempts += 1;
    this.setStatus(op, "PENDING", `отправка (${adapter.mode})`);
    this.d.save();
    // a live write must be on disk BEFORE it leaves the server (crash after sending ≠ forgotten operation)
    if (adapter.mode === "live" && this.d.flush) await this.d.flush();

    const sign = op.type === "LOAD" ? 1 : -1;
    const notes = fillUpNotes(op, user);
    const call = adapter.makeFillUp({
      operationId: op.id,
      shopId: op.shopId,
      notes,
      lines: op.lines.map((l) => ({ kitshopProductId: l.kitshopProductId, fillup: sign * l.qty })),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      call.catch((e): WriteOutcome => ({ kind: "unknown", reason: e instanceof Error ? e.message : "ошибка отправки" })),
      new Promise<typeof TIMEOUT>((r) => (timer = setTimeout(() => r(TIMEOUT), this.d.timeoutMs))),
    ]);
    clearTimeout(timer);
    if (outcome === TIMEOUT) {
      this.apply(op, { kind: "unknown", reason: `KiT Shop не ответил за ${Math.round(this.d.timeoutMs / 1000)} с` }, user);
      // a late answer still counts — but only while nobody decided otherwise
      call.then((late) => {
        if (op.status === "UNKNOWN" || op.status === "REQUIRES_REVIEW") {
          this.apply(op, late, "system");
          this.d.save();
        }
      }).catch(() => undefined);
    } else {
      this.apply(op, outcome, user);
    }
    this.d.save();
    if (op.status === "CONFIRMED") await this.releaseDependents(op, user);
  }

  private apply(op: KsOperation, o: WriteOutcome, user: string) {
    switch (o.kind) {
      case "ok":
        op.confirmedAt = this.d.now();
        op.kitshopFillupId = o.fillupId ?? op.kitshopFillupId;
        this.setStatus(op, "CONFIRMED", o.message ?? "KiT Shop подтвердил");
        this.d.onConfirmed?.(op);
        break;
      case "rejected":
        op.errorCode = o.code === 13 ? "NO_RIGHTS" : o.code === 100 && /баз/i.test(o.message) ? "NOT_IN_SHOP_BASE" : o.code === 100 ? "SHOP_NOT_FOUND" : "KITSHOP_ERROR";
        op.error = `${o.message} (код ${o.code})`;
        this.setStatus(op, "FAILED", op.error);
        break;
      case "unknown":
        op.error = o.reason;
        this.setStatus(op, "UNKNOWN", `${o.reason} — статус проверяется`);
        break;
      case "unreachable":
        op.attempts -= 1; // never left our server
        op.error = o.reason;
        this.setStatus(op, "WAITING_FOR_CONNECTION", o.reason);
        break;
    }
    this.audit(user, "op.result", "operation", op.id, { status: op.status, outcome: o.kind, mode: op.adapterMode, error: op.error });
  }

  private async releaseDependents(parent: KsOperation, user: string) {
    for (const child of this.d.state.operations.filter((o) => o.dependsOn === parent.id && o.status === "DRAFT")) await this.send(child, user);
  }

  /** Checks an UNKNOWN operation through KiT Shop read methods. Never sends a write. */
  async verify(id: string, user: string): Promise<KsOperation> {
    const op = this.require(id);
    if (op.status !== "UNKNOWN" && op.status !== "REQUIRES_REVIEW" && op.status !== "PENDING") return op;
    const adapter = this.d.adapterFor(op.shopId, op.origin);
    const res = await adapter.verifyFillUp({ id: op.id, shopId: op.shopId, sentAt: op.sentAt ?? op.createdAt }).catch((e) => ({
      kind: "unverifiable" as const,
      reason: e instanceof Error ? e.message : "проверка не удалась",
    }));
    const before = op.status;
    if (res.kind === "found") {
      op.confirmedAt = this.d.now();
      op.kitshopFillupId = res.fillupId ?? op.kitshopFillupId;
      op.error = null;
      this.setStatus(op, "CONFIRMED", "найдено в KiT Shop при проверке");
      this.d.onConfirmed?.(op);
    } else if (res.kind === "absent") {
      if (!this.d.trustAbsent(op.adapterMode)) {
        if (op.status !== "REQUIRES_REVIEW") this.setStatus(op, "REQUIRES_REVIEW", "не найдено автоматически — проверьте в кабинете KiT Shop");
      } else if (this.d.now() - (op.sentAt ?? op.createdAt) >= this.d.verifyWindowMs) {
        op.errorCode = "KITSHOP_ERROR";
        op.error = "Операция не найдена в KiT Shop — её можно отправить повторно";
        this.setStatus(op, "FAILED", op.error);
      }
    } else if (op.status !== "REQUIRES_REVIEW") {
      this.setStatus(op, "REQUIRES_REVIEW", res.reason);
    }
    this.audit(user, "op.verify", "operation", op.id, { from: before, to: op.status, result: res.kind });
    this.d.save();
    if ((op.status as OpStatus) === "CONFIRMED") await this.releaseDependents(op, user);
    return op;
  }

  /** Manual re-send by a person. Allowed only when the previous attempt provably did not apply. */
  async retry(id: string, user: string): Promise<KsOperation> {
    const op = this.require(id);
    if (op.status === "UNKNOWN" || op.status === "REQUIRES_REVIEW" || op.status === "PENDING")
      throw new OpsError(409, "CONFLICT", "Статус неизвестен — сначала проверка, повторная отправка может задвоить товар");
    if (op.status === "CONFIRMED") throw new OpsError(409, "CONFLICT", "Операция уже подтверждена");
    this.assertNotPaused();
    this.audit(user, "op.retry", "operation", op.id, { from: op.status });
    await this.send(op, user);
    return op;
  }

  /** Manager decision after checking the KiT Shop cabinet. */
  resolve(id: string, decision: "confirmed" | "failed", user: string, note = ""): KsOperation {
    const op = this.require(id);
    if (op.status !== "UNKNOWN" && op.status !== "REQUIRES_REVIEW") throw new OpsError(409, "CONFLICT", "Ручное решение только для операций с неизвестным статусом");
    if (decision === "confirmed") {
      op.confirmedAt = this.d.now();
      this.setStatus(op, "CONFIRMED", `подтверждено вручную: ${user}${note ? ` — ${note}` : ""}`);
      this.d.onConfirmed?.(op);
    } else {
      op.errorCode = "KITSHOP_ERROR";
      op.error = `не применено (проверено вручную: ${user})`;
      this.setStatus(op, "FAILED", op.error);
    }
    this.audit(user, "op.resolve", "operation", op.id, { decision, note });
    this.d.save();
    return op;
  }

  /** Background pass: send provably-unsent ops once, verify UNKNOWN ones. */
  async tick(user = "system"): Promise<{ sent: number; verified: number }> {
    let sent = 0;
    let verified = 0;
    const paused = !!this.d.isPaused?.();
    for (const op of paused ? [] : this.d.state.operations.filter((o) => o.status === "WAITING_FOR_CONNECTION")) {
      await this.send(op, user);
      sent++;
    }
    for (const op of this.d.state.operations.filter((o) => o.status === "UNKNOWN" && this.d.now() - (o.sentAt ?? 0) > 15_000)) {
      await this.verify(op.id, user);
      verified++;
    }
    return { sent, verified };
  }

  /** TRANSFER: source UNLOAD + one LOAD per target. Deterministic ids → completing the mission twice never doubles it. */
  async transfer(t: TransferInput, user: string): Promise<KsOperation[]> {
    const total = new Map<string, OpLine>();
    for (const tg of t.targets)
      for (const l of tg.lines) {
        const cur = total.get(l.productId);
        total.set(l.productId, cur ? { ...cur, qty: cur.qty + l.qty } : { ...l });
      }
    const lines = [...total.values()].filter((l) => l.qty > 0);
    if (!lines.length) return [];
    const srcId = `tr:${t.missionId}:src`;
    const { op: src } = await this.submit(
      { id: srcId, type: "UNLOAD", ...t.source, lines, missionId: t.missionId, transferId: t.missionId, transferRole: "source", applyToSim: t.applyToSim },
      user,
    );
    const out = [src];
    for (const tg of t.targets) {
      if (!tg.lines.some((l) => l.qty > 0)) continue;
      const { op } = await this.submit(
        {
          id: `tr:${t.missionId}:tgt:${tg.fridgeId}`,
          type: "LOAD",
          fridgeId: tg.fridgeId,
          shopId: tg.shopId,
          fridgeName: tg.fridgeName,
          lines: tg.lines,
          missionId: t.missionId,
          transferId: t.missionId,
          transferRole: "target",
          dependsOn: srcId,
          applyToSim: t.applyToSim,
        },
        user,
      );
      out.push(op);
    }
    return out;
  }

  transferState(missionId: string): TransferState {
    const ops = this.d.state.operations.filter((o) => o.transferId === missionId);
    if (!ops.length) return "NONE";
    if (ops.every((o) => o.status === "CONFIRMED")) return "CONFIRMED";
    const src = ops.find((o) => o.transferRole === "source");
    if (ops.some((o) => o.status === "UNKNOWN" || o.status === "REQUIRES_REVIEW")) return "ATTENTION";
    if (src?.status === "CONFIRMED" && ops.some((o) => o.status === "FAILED")) return "PARTIAL";
    if (src?.status === "FAILED") return "FAILED";
    return "IN_PROGRESS";
  }

  private require(id: string): KsOperation {
    const op = this.get(id);
    if (!op) throw new OpsError(404, "NOT_FOUND", "Операция не найдена");
    return op;
  }
}
