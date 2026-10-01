import type { CatalogProductInput, FillUpRequest, KitShopWriteAdapter, VerifyOutcome, WriteOutcome } from "./types";

/**
 * Non-network write adapters.
 *  • MockWriteAdapter — a fake KiT Shop for development, the demo and tests (can simulate failures).
 *  • DryRunWriteAdapter — logs EXACTLY what would be sent (body without Auth) and sends nothing.
 * The real adapter lives in services/kitshop/writer.ts and is used only when the write gate is fully open.
 */

export type MockScenario =
  | "ok"
  /** KiT Shop refuses (ResultCode 1) */
  | "reject"
  /** no answer; the write did NOT happen */
  | "timeout"
  /** the write happened but the answer was lost */
  | "lost"
  /** network down before sending */
  | "unreachable"
  /** answers OK after 5 s (to see the "slower than usual" state) */
  | "slow";

export class MockWriteAdapter implements KitShopWriteAdapter {
  readonly mode = "mock" as const;
  /** operations KiT Shop "applied" (by operation id) */
  readonly ledger = new Map<string, FillUpRequest & { fillupId: string }>();
  /** queued outcomes for the next calls (tests / dev panel); empty → "ok" */
  readonly script: MockScenario[] = [];
  /** when set: products available in each shop's product base; others are refused like ResultCode 100 */
  shopBase: Map<string, Set<string>> | null = null;
  calls = 0;
  private seq = 1000;

  constructor(public delayMs = 0) {}

  async makeFillUp(req: FillUpRequest): Promise<WriteOutcome> {
    this.calls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const scenario = this.script.shift() ?? "ok";
    if (scenario === "slow") await new Promise((r) => setTimeout(r, 5_000));
    if (scenario === "unreachable") return { kind: "unreachable", reason: "mock: нет связи с KiT Shop" };
    if (scenario === "timeout") return { kind: "unknown", reason: "mock: KiT Shop не ответил" };
    if (scenario === "reject") return { kind: "rejected", code: 1, message: "mock: неизвестная ошибка KiT Shop" };
    const base = this.shopBase?.get(req.shopId);
    const missing = base ? req.lines.find((l) => !base.has(l.kitshopProductId)) : undefined;
    if (missing) return { kind: "rejected", code: 100, message: `Товар ${missing.kitshopProductId} не найден в товарной базе точки` };
    const fillupId = String(++this.seq);
    this.ledger.set(req.operationId, { ...req, fillupId });
    if (scenario === "lost") return { kind: "unknown", reason: "mock: ответ потерян" };
    return { kind: "ok", message: "Успешное загрузка товаров", fillupId };
  }

  async verifyFillUp(op: { id: string }): Promise<VerifyOutcome> {
    const hit = this.ledger.get(op.id);
    return hit ? { kind: "found", fillupId: hit.fillupId } : { kind: "absent" };
  }

  async addProduct(p: CatalogProductInput): Promise<WriteOutcome & { productId?: string }> {
    this.calls++;
    const scenario = this.script.shift() ?? "ok";
    if (scenario !== "ok") return { kind: "rejected", code: 1, message: `mock: ${scenario}` };
    const productId = String(900_000 + ++this.seq);
    return { kind: "ok", productId, message: `mock: создан «${p.name}»` };
  }
}

export class DryRunWriteAdapter implements KitShopWriteAdapter {
  readonly mode = "dry-run" as const;
  readonly sent: { method: string; body: unknown }[] = [];

  constructor(private log: (line: string) => void = (l) => console.info(l)) {}

  private record(method: string, body: unknown) {
    this.sent.push({ method, body });
    this.log(`[kitshop:dry-run] WOULD POST ${method} ${JSON.stringify(body)}`);
  }

  async makeFillUp(req: FillUpRequest): Promise<WriteOutcome> {
    this.record("MakeFillUp", fillUpBody(req));
    return { kind: "ok", message: "DRY-RUN: в KiT Shop ничего не отправлено" };
  }

  async verifyFillUp(): Promise<VerifyOutcome> {
    return { kind: "found", fillupId: null };
  }

  async addProduct(p: CatalogProductInput): Promise<WriteOutcome & { productId?: string }> {
    this.record("AddProduct", addProductBody(p));
    return { kind: "ok", message: "DRY-RUN: товар не создан, запрос только записан в журнал" };
  }
}

/** MakeFillUp body (docs §3.21), without Auth. */
export function fillUpBody(req: FillUpRequest) {
  return {
    ShopId: Number(req.shopId),
    Notes: req.notes,
    FillUps: req.lines.map((l) => ({ ProductId: Number(l.kitshopProductId), Fillup: l.fillup })),
  };
}

/** AddProduct body (docs §3.16), without Auth. */
export function addProductBody(p: CatalogProductInput) {
  return {
    ProductName: p.name,
    UnitType: p.unitType,
    TaxType: p.taxType,
    AccuracyType: p.accuracyType,
    ...(p.price !== null ? { Price: p.price } : {}),
    ...(p.barcode ? { Barcode: p.barcode } : {}),
    ...(p.vendorCode ? { VendorCode: p.vendorCode } : {}),
  };
}
