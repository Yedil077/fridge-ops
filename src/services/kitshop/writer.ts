import "server-only";
import { addProductBody, fillUpBody } from "@/lib/kitshop-ops/adapters";
import { noteMarker, type CatalogProductInput, type FillUpRequest, type KitShopWriteAdapter, type VerifyOutcome, type WriteOutcome } from "@/lib/kitshop-ops/types";
import type { KitShopConfig, KitShopWriteConfig } from "./config";
import { KitShopReadOnlyClient } from "./kitshopClient";
import { DEFINITE_REJECT_CODES, KitShopTransport, KitShopTransportError } from "./transport";

/**
 * LIVE KiT Shop writer — the only code that can change data in KiT Shop.
 * Documented methods only (audit §2): MakeFillUp (load/unload) and AddProduct (admin, catalog).
 * Deliberately absent: product deletion, product-base removal, terminal/lock commands.
 *
 * Constructed ONLY by lib/server/kitshopWrite.ts when the gate is fully open:
 * KITSHOP_ENABLED && KITSHOP_WRITE_ENABLED && !KITSHOP_WRITE_DRY_RUN && shop ∈ KITSHOP_WRITE_SHOPS.
 * The writer re-checks the gate itself on every call (defence in depth).
 */
export class KitShopLiveWriter implements KitShopWriteAdapter {
  readonly mode = "live" as const;

  constructor(
    private config: KitShopConfig,
    private gate: KitShopWriteConfig,
    private transport: KitShopTransport,
    private reader: KitShopReadOnlyClient,
  ) {}

  private assertOpen(shopId?: string) {
    if (!this.config.enabled || !this.gate.writeEnabled || this.gate.dryRun) throw new Error("KiT Shop write gate is closed");
    if (shopId !== undefined && !this.gate.shops.includes(shopId)) throw new Error(`Shop ${shopId} is not in KITSHOP_WRITE_SHOPS`);
  }

  async makeFillUp(req: FillUpRequest): Promise<WriteOutcome> {
    this.assertOpen(req.shopId);
    if (req.lines.some((l) => !Number.isInteger(l.fillup) || l.fillup === 0)) return { kind: "rejected", code: 28, message: "Некорректное количество" };
    try {
      const env = await this.transport.call("MakeFillUp", fillUpBody(req), this.gate.timeoutMs + 5_000);
      if (env.ResultCode === 0) return { kind: "ok", message: env.Response };
      if (DEFINITE_REJECT_CODES.has(env.ResultCode))
        return { kind: "rejected", code: env.ResultCode, message: env.ErrorMessage ?? env.Response ?? "KiT Shop отказал" };
      return { kind: "unknown", reason: `Неизвестный код ответа ${env.ResultCode}` };
    } catch (e) {
      if (e instanceof KitShopTransportError && e.kind === "unreachable") return { kind: "unreachable", reason: e.message };
      return { kind: "unknown", reason: e instanceof Error ? e.message : "нет ответа" };
    }
  }

  /** GetFillUps for the shop around the send time → look for FO:<uuid> in Notes. */
  async verifyFillUp(op: { id: string; shopId: string; sentAt: number }): Promise<VerifyOutcome> {
    try {
      const list = await this.reader.getFillUps({ from: op.sentAt - 10 * 60_000, to: op.sentAt + 60 * 60_000, shopId: op.shopId });
      const hit = list.find((f) => f.Notes?.includes(noteMarker(op.id)));
      return hit ? { kind: "found", fillupId: hit.FillupId } : { kind: "absent" };
    } catch (e) {
      return { kind: "unverifiable", reason: e instanceof Error ? e.message : "проверка не удалась" };
    }
  }

  async addProduct(p: CatalogProductInput): Promise<WriteOutcome & { productId?: string }> {
    this.assertOpen();
    try {
      const env = await this.transport.call("AddProduct", addProductBody(p), this.gate.timeoutMs + 5_000);
      if (env.ResultCode === 0 && env.Id !== undefined) return { kind: "ok", productId: String(env.Id) };
      if (DEFINITE_REJECT_CODES.has(env.ResultCode)) return { kind: "rejected", code: env.ResultCode, message: env.ErrorMessage ?? "KiT Shop отказал" };
      return { kind: "unknown", reason: `Код ответа ${env.ResultCode}` };
    } catch (e) {
      if (e instanceof KitShopTransportError && e.kind === "unreachable") return { kind: "unreachable", reason: e.message };
      return { kind: "unknown", reason: e instanceof Error ? e.message : "нет ответа" };
    }
  }
}
