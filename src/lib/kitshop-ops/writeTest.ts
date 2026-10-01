import { fillUpNotes, OpsError, type SubmitInput } from "./service";
import type { AuditEntry, KsOperation, OpStatus, VerifyOutcome } from "./types";

/**
 * PHASE D — REAL WRITE TEST on ONE test shop and ONE test product (docs/KITSHOP_WRITE_API_AUDIT.md §5).
 *
 *   1 check connection (read-only)  →  2 read stock  →  3 prepare LOAD +1 (preview, nothing sent)
 *   4 admin presses "ПОДТВЕРДИТЬ ТЕСТОВУЮ ЗАГРУЗКУ +1" → MakeFillUp  →  5 read stock again: expected == actual?
 *   then UNLOAD −1 the same way, back to the original quantity → summary READY / NOT READY.
 *
 * A KiT Shop "success" alone never passes a step: the stock read back after the write must match.
 * A lost answer is never re-sent: the UUID is searched in GetFillUps (found → CONFIRMED, not found → REQUIRES_REVIEW).
 */

export interface TestShop {
  /** stable KiT Shop ShopId */
  shopId: string;
  name: string;
  /** our fridge with this ShopId, if any */
  fridgeId: string | null;
  setBy: string;
  at: number;
}

export interface TestProduct {
  /** KiT Shop ProductId */
  productId: string;
  name: string;
  barcode: string | null;
  setBy: string;
  at: number;
}

export type StepResult = "PENDING" | "PASS" | "FAIL" | "REQUIRES_REVIEW";

export interface TestLeg {
  kind: "LOAD" | "UNLOAD";
  delta: 1 | -1;
  opId: string;
  notes: string;
  preparedAt: number;
  preparedBy: string;
  before: number | null;
  expected: number | null;
  actual: number | null;
  sentAt: number | null;
  /** time until our server got KiT Shop's answer (or gave up) */
  responseMs: number | null;
  opStatus: OpStatus | null;
  /** UUID found in GetFillUps (reconciliation path for a lost answer) */
  fillUpsMatch: "FOUND" | "ABSENT" | "UNVERIFIABLE" | null;
  result: StepResult;
  detail: string | null;
}

export interface WriteTestRun {
  id: string;
  startedAt: number;
  startedBy: string;
  shop: TestShop;
  product: TestProduct;
  auth: { result: StepResult; at: number; ms: number; detail: string | null } | null;
  load: TestLeg | null;
  unload: TestLeg | null;
  duplicate: { result: StepResult; detail: string } | null;
  audit: { result: StepResult; detail: string } | null;
  finishedAt: number | null;
}

export interface KitShopAdminState {
  writesPaused: boolean;
  pausedBy: string | null;
  pausedAt: number | null;
  testShop: TestShop | null;
  testProduct: TestProduct | null;
  writeTest: WriteTestRun | null;
}

export interface WriteTestDeps {
  state: KitShopAdminState;
  now(): number;
  newId(): string;
  /** read-only: CheckAuth */
  checkAuth(): Promise<{ ok: boolean; ms: number; detail: string | null }>;
  /** read-only: GetShopStocks(shop) → quantity of the product (0 when absent) */
  readStock(shopId: string, productId: string): Promise<number>;
  /** null when a LIVE write for this shop is allowed from the wizard; otherwise the reason */
  liveBlocked(shopId: string): string | null;
  isPaused(): boolean;
  submit(input: SubmitInput, user: string): Promise<{ op: KsOperation; duplicate: boolean }>;
  verify(opId: string, user: string): Promise<KsOperation>;
  getOp(opId: string): KsOperation | undefined;
  /** read-only GetFillUps search for FO:<uuid> */
  findInFillUps(op: KsOperation): Promise<VerifyOutcome>;
  auditFor(opId: string): AuditEntry[];
  save(): void;
}

export class WriteTest {
  constructor(private d: WriteTestDeps) {}

  get run(): WriteTestRun | null {
    return this.d.state.writeTest;
  }

  /** New run for the configured test shop + product. Refused while a sent leg is unresolved. */
  start(user: string): WriteTestRun {
    const { testShop, testProduct } = this.d.state;
    if (!testShop || !testProduct) throw new OpsError(400, "INVALID", "Сначала выберите TEST SHOP и TEST PRODUCT");
    const cur = this.run;
    if (cur && !cur.finishedAt && [cur.load, cur.unload].some((l) => l?.sentAt && l.result !== "PASS" && l.result !== "FAIL"))
      throw new OpsError(409, "CONFLICT", "Предыдущий тест не завершён: есть отправленная операция без итога. Сначала проверьте её.");
    const run: WriteTestRun = {
      id: this.d.newId(),
      startedAt: this.d.now(),
      startedBy: user,
      shop: testShop,
      product: testProduct,
      auth: null,
      load: null,
      unload: null,
      duplicate: null,
      audit: null,
      finishedAt: null,
    };
    this.d.state.writeTest = run;
    this.d.save();
    return run;
  }

  private requireRun(): WriteTestRun {
    const r = this.run;
    if (!r) throw new OpsError(400, "INVALID", "Тест не начат");
    return r;
  }

  /** STEP 1 — read-only connection check. */
  async checkConnection(): Promise<WriteTestRun> {
    const r = this.requireRun();
    const res = await this.d.checkAuth();
    r.auth = { result: res.ok ? "PASS" : "FAIL", at: this.d.now(), ms: res.ms, detail: res.detail };
    this.d.save();
    return r;
  }

  /** STEP 2+3 — read the current stock and prepare the operation with a NEW uuid. Nothing is sent. */
  async prepare(kind: "LOAD" | "UNLOAD", user: string): Promise<WriteTestRun> {
    const r = this.requireRun();
    if (r.auth?.result !== "PASS") throw new OpsError(409, "CONFLICT", "Шаг 1: сначала успешная проверка подключения");
    if (kind === "UNLOAD" && r.load?.result !== "PASS") throw new OpsError(409, "CONFLICT", "Разгрузка −1 — только после успешной загрузки +1");
    const leg = kind === "LOAD" ? r.load : r.unload;
    if (leg?.sentAt) throw new OpsError(409, "CONFLICT", "Эта операция уже отправлена — повторная подготовка запрещена");
    const before = await this.d.readStock(r.shop.shopId, r.product.productId);
    const opId = this.d.newId();
    const delta = kind === "LOAD" ? 1 : -1;
    if (kind === "UNLOAD" && before < 1) throw new OpsError(409, "CONFLICT", `Остаток ${before} — разгружать нечего`);
    const next: TestLeg = {
      kind,
      delta,
      opId,
      notes: fillUpNotes({ id: opId, type: kind, reason: "WRITE-TEST" }, user),
      preparedAt: this.d.now(),
      preparedBy: user,
      before,
      expected: before + delta,
      actual: null,
      sentAt: null,
      responseMs: null,
      opStatus: null,
      fillUpsMatch: null,
      result: "PENDING",
      detail: null,
    };
    if (kind === "LOAD") r.load = next;
    else r.unload = next;
    this.d.save();
    return r;
  }

  /** STEP 4 — the ONLY place that sends: after the admin pressed the confirm button for exactly this uuid. */
  async confirm(kind: "LOAD" | "UNLOAD", opId: string, user: string): Promise<WriteTestRun> {
    const r = this.requireRun();
    const leg = kind === "LOAD" ? r.load : r.unload;
    if (!leg || leg.opId !== opId) throw new OpsError(409, "CONFLICT", "Операция не подготовлена или устарела — подготовьте заново");
    if (leg.sentAt) return this.evaluate(kind, user); // repeated tap: the same uuid is never sent twice
    if (this.d.isPaused()) throw new OpsError(423, "WRITES_PAUSED", "Запись приостановлена (PAUSE ALL WRITES)");
    const blocked = this.d.liveBlocked(r.shop.shopId);
    if (blocked) throw new OpsError(409, "CONFLICT", `Реальная запись недоступна: ${blocked}`);

    leg.sentAt = this.d.now();
    this.d.save();
    const t0 = Date.now();
    const { op } = await this.d.submit(
      {
        id: leg.opId,
        type: kind,
        fridgeId: r.shop.fridgeId ?? `ks-${r.shop.shopId}`,
        shopId: r.shop.shopId,
        fridgeName: r.shop.name,
        lines: [{ productId: `ks:${r.product.productId}`, kitshopProductId: r.product.productId, name: r.product.name, qty: 1 }],
        reason: "WRITE-TEST",
        origin: "write-test",
        applyToSim: false,
      },
      user,
    );
    leg.responseMs = Date.now() - t0;
    leg.opStatus = op.status;

    if (kind === "LOAD") {
      // duplicate protection: the same uuid again must NOT reach KiT Shop
      const again = await this.d.submit({ id: leg.opId } as SubmitInput, user);
      const ok = again.duplicate && again.op.attempts === op.attempts;
      r.duplicate = { result: ok ? "PASS" : "FAIL", detail: ok ? `повтор того же UUID не отправлен (попыток: ${op.attempts})` : "повтор UUID дошёл до отправки!" };
    }
    return this.evaluate(kind, user);
  }

  /** STEP 5 — read back. UNKNOWN → reconcile through GetFillUps first (never re-send). Can be repeated ("ПРОВЕРИТЬ ЕЩЁ РАЗ"). */
  async evaluate(kind: "LOAD" | "UNLOAD", user: string): Promise<WriteTestRun> {
    const r = this.requireRun();
    const leg = kind === "LOAD" ? r.load : r.unload;
    if (!leg?.sentAt) throw new OpsError(409, "CONFLICT", "Операция ещё не отправлена");
    let op = this.d.getOp(leg.opId);
    if (!op) {
      leg.result = "REQUIRES_REVIEW";
      leg.detail = "Операция не найдена в журнале";
      this.d.save();
      return r;
    }
    if (op.status === "UNKNOWN" || op.status === "PENDING" || op.status === "REQUIRES_REVIEW") op = await this.d.verify(op.id, user);
    leg.opStatus = op.status;

    if (op.status === "FAILED") {
      leg.result = "FAIL";
      leg.detail = op.error ?? "KiT Shop отклонил операцию";
    } else if (op.status === "CONFIRMED" || op.status === "REQUIRES_REVIEW") {
      const fu = await this.d.findInFillUps(op);
      leg.fillUpsMatch = fu.kind === "found" ? "FOUND" : fu.kind === "absent" ? "ABSENT" : "UNVERIFIABLE";
      leg.actual = await this.d.readStock(r.shop.shopId, r.product.productId);
      const stockOk = leg.actual === leg.expected;
      if (op.status === "CONFIRMED" && stockOk) {
        leg.result = "PASS";
        leg.detail = `KiT Shop подтвердил, остаток ${leg.before} → ${leg.actual}`;
      } else {
        leg.result = "REQUIRES_REVIEW";
        leg.detail =
          op.status !== "CONFIRMED"
            ? "Ответ KiT Shop не получен, UUID не найден в GetFillUps — проверьте в кабинете KiT Shop"
            : `Остаток не совпал: ожидали ${leg.expected}, фактически ${leg.actual}. Возможно, была продажа или KiT Shop обновляет остатки с задержкой — проверьте ещё раз.`;
      }
    } else {
      leg.result = "PENDING";
      leg.detail = `Статус операции: ${op.status}`;
    }

    if (leg.result === "PASS" || leg.result === "FAIL") {
      const actions = new Set(this.d.auditFor(leg.opId).map((a) => a.action));
      const ok = actions.has("op.create") && actions.has("op.result");
      if (kind === "LOAD" || r.audit?.result !== "FAIL")
        r.audit = { result: ok ? "PASS" : "FAIL", detail: ok ? "создание и результат операции записаны в audit log" : "в audit log нет записи о создании/результате" };
    }
    if (kind === "UNLOAD" && leg.result !== "PENDING") r.finishedAt = this.d.now();
    if (leg.result === "FAIL" && kind === "LOAD") r.finishedAt = this.d.now();
    this.d.save();
    return r;
  }
}

export interface SummaryLine {
  label: string;
  result: StepResult;
  detail: string | null;
}

export function summarize(r: WriteTestRun | null): { lines: SummaryLine[]; ready: boolean } {
  if (!r) return { lines: [], ready: false };
  const stock: StepResult =
    r.load?.result === "PASS" && r.unload?.result === "PASS"
      ? "PASS"
      : [r.load, r.unload].some((l) => l?.result === "REQUIRES_REVIEW" || l?.result === "FAIL")
        ? "FAIL"
        : "PENDING";
  const reconcile: StepResult =
    r.load?.fillUpsMatch === "FOUND" && r.unload?.fillUpsMatch === "FOUND"
      ? "PASS"
      : [r.load, r.unload].some((l) => l?.fillUpsMatch === "ABSENT" || l?.fillUpsMatch === "UNVERIFIABLE")
        ? "FAIL"
        : "PENDING";
  const lines: SummaryLine[] = [
    { label: "Authentication", result: r.auth?.result ?? "PENDING", detail: r.auth?.detail ?? null },
    { label: "Load +1", result: r.load?.result ?? "PENDING", detail: r.load?.detail ?? null },
    { label: "Unload −1", result: r.unload?.result ?? "PENDING", detail: r.unload?.detail ?? null },
    { label: "Stock verification", result: stock, detail: r.load && r.unload ? `${r.load.before} → ${r.load.actual ?? "?"} → ${r.unload.actual ?? "?"}` : null },
    { label: "Duplicate protection", result: r.duplicate?.result ?? "PENDING", detail: r.duplicate?.detail ?? null },
    { label: "Audit log", result: r.audit?.result ?? "PENDING", detail: r.audit?.detail ?? null },
    { label: "UUID в GetFillUps (сверка потерянного ответа)", result: reconcile, detail: reconcile === "FAIL" ? "Notes не вернулись в GetFillUps — сверка UUID работать не будет" : null },
  ];
  return { lines, ready: lines.every((l) => l.result === "PASS") };
}
