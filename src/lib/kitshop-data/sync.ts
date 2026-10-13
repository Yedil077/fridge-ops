import type { KitShopReadOnlyClient } from "@/services/kitshop/kitshopClient";
import { parseKitshopDate } from "@/services/kitshop/transport";
import type { KsDataset, KsPosition, KsSale } from "./dataset";
import type { KsRepo } from "./repo";

/**
 * 5-minute READ-ONLY sync: KiT Shop → our database (the cache every screen reads).
 *  • catalog (GetShops + GetProducts): every 6 h or on demand;
 *  • stock (GetShopStocks) of our fridges: every tick (≥ 5 min apart);
 *  • new receipts (GetSales) since the last sync with a 15-min overlap — never the whole history again;
 *  • backfill of 180 days in 1-day GetSales chunks (API limit 60 days), newest first;
 *  • product lines (GetSaleById per receipt — the only documented product-level source), newest first, budgeted.
 * Calls only get* methods of the read-only client. Nothing in KiT Shop is ever changed.
 */

type Reader = Pick<KitShopReadOnlyClient, "getShops" | "getProducts" | "getShopStocks" | "getSales" | "getSaleById">;

export interface SyncOptions {
  backfillDays: number;
  backfillChunkDays: number;
  /** backfill chunks per tick */
  backfillChunksPerTick: number;
  detailsPerTick: number;
  catalogEveryMs: number;
  stockEveryMs: number;
  salesOverlapMs: number;
  /** stop detailing when a tick has run this long */
  maxTickMs: number;
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  backfillDays: 180,
  backfillChunkDays: 1,
  backfillChunksPerTick: 3,
  detailsPerTick: 400,
  catalogEveryMs: 6 * 3_600_000,
  stockEveryMs: 4.5 * 60_000,
  salesOverlapMs: 15 * 60_000,
  maxTickMs: 4 * 60_000,
};

export interface SyncDeps {
  reader: Reader;
  repo: KsRepo;
  ds: KsDataset;
  /** wall-clock ms in the fridges' timezone */
  now: () => number;
  /** KiT Shop ShopIds of OUR fridges */
  ourShopIds: string[];
  /** added to KiT Shop times (if KiT Shop reports another timezone) */
  timeOffsetMs?: number;
  options?: Partial<SyncOptions>;
}

export interface TickResult {
  ok: boolean;
  steps: { step: string; ok: boolean; count: number; error?: string }[];
  ms: number;
  backlog: { undetailed: number; backfillDaysLeft: number };
}

const DAY = 86_400_000;

export class KitShopSync {
  readonly o: SyncOptions;
  running = false;
  lastTick: TickResult | null = null;
  constructor(private d: SyncDeps) {
    this.o = { ...DEFAULT_SYNC_OPTIONS, ...(d.options ?? {}) };
  }

  backlog() {
    const target = this.d.now() - this.o.backfillDays * DAY;
    let undetailed = 0;
    for (const s of this.d.ds.sales.values()) if (!s.detailed) undetailed++;
    const from = this.d.ds.state.backfillFrom;
    return { undetailed, backfillDaysLeft: from === null ? this.o.backfillDays : Math.max(0, Math.ceil((from - target) / DAY)) };
  }

  private toWall(s: string): number | null {
    const t = parseKitshopDate(s);
    return t === null ? null : t + (this.d.timeOffsetMs ?? 0);
  }

  private async addSales(rows: Awaited<ReturnType<Reader["getSales"]>>): Promise<number> {
    const { ds, repo } = this.d;
    const fresh: KsSale[] = [];
    for (const r of rows) {
      const soldAt = this.toWall(r.SaleDateTime);
      if (soldAt === null) continue;
      const cur = ds.sales.get(r.SaleId);
      if (cur && cur.soldAt === soldAt && cur.shopId === r.ShopId) continue;
      const sale: KsSale = { saleId: r.SaleId, shopId: r.ShopId, soldAt, total: r.Sum ?? null, detailed: cur?.detailed ?? false };
      ds.sales.set(sale.saleId, sale);
      fresh.push(sale);
    }
    if (fresh.length) {
      await repo.saveSales(fresh);
      ds.touch();
    }
    return fresh.length;
  }

  /** One pass. Never throws: every step reports its own result. */
  async tick(force: { catalog?: boolean } = {}): Promise<TickResult> {
    if (this.running) return this.lastTick ?? { ok: false, steps: [{ step: "busy", ok: false, count: 0 }], ms: 0, backlog: this.backlog() };
    this.running = true;
    const t0 = Date.now();
    const { reader, repo, ds } = this.d;
    const steps: TickResult["steps"] = [];
    const now = this.d.now();
    const step = async (name: string, f: () => Promise<number>) => {
      try {
        const count = await f();
        steps.push({ step: name, ok: true, count });
        return true;
      } catch (e) {
        steps.push({ step: name, ok: false, count: 0, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
        return false;
      }
    };
    try {
      // 1. catalog
      if (force.catalog || !ds.state.lastCatalogSyncAt || now - ds.state.lastCatalogSyncAt >= this.o.catalogEveryMs || !ds.shops.size) {
        const okShops = await step("GetShops", async () => {
          const shops = await reader.getShops();
          for (const s of shops)
            ds.shops.set(s.ShopId, { shopId: s.ShopId, name: s.ShopName, stocksAccounting: s.StocksAccounting === undefined || s.StocksAccounting === null ? null : !!s.StocksAccounting });
          await repo.saveShops([...ds.shops.values()]);
          return shops.length;
        });
        const okProducts = await step("GetProducts", async () => {
          const products = await reader.getProducts();
          for (const p of products)
            ds.products.set(p.ProductId, {
              productId: p.ProductId,
              name: p.ProductName,
              barcode: p.Barcode ?? null,
              vendorCode: p.VendorCode ?? null,
              price: p.Price ?? null,
              groupId: p.GroupId ?? null,
            });
          await repo.saveProducts([...ds.products.values()]);
          return products.length;
        });
        if (okShops && okProducts) ds.state.lastCatalogSyncAt = now;
        ds.touch();
        if (!okShops && !ds.shops.size) throw new Error(steps.at(-2)?.error ?? "KiT Shop недоступен");
      }

      // 2. stock of our fridges
      if (!ds.state.lastStockSyncAt || now - ds.state.lastStockSyncAt >= this.o.stockEveryMs) {
        const shopIds = this.d.ourShopIds.filter((id) => !ds.shops.size || ds.shops.has(id));
        let all = true;
        for (const shopId of shopIds) {
          const ok = await step(`GetShopStocks ${shopId}`, async () => {
            const rows = await reader.getShopStocks(shopId);
            const m = new Map<string, number>();
            for (const r of rows) if (r.Quantity > 0) m.set(r.ProductId, (m.get(r.ProductId) ?? 0) + r.Quantity);
            ds.stock.set(shopId, m);
            ds.stockAt.set(shopId, now);
            await repo.replaceStock(shopId, [...m.entries()].map(([productId, qty]) => ({ shopId, productId, qty })), now);
            return m.size;
          });
          all &&= ok;
        }
        if (all) ds.state.lastStockSyncAt = now;
        ds.touch();
      }

      // 3. new receipts since the last sync (overlap → nothing is missed, duplicates are ignored)
      const from = ds.state.lastSalesSyncAt !== null ? ds.state.lastSalesSyncAt - this.o.salesOverlapMs : now - DAY;
      const okSales = await step("GetSales (новые)", async () => {
        let n = 0;
        for (let a = from; a < now; a += 30 * DAY) n += await this.addSales(await reader.getSales({ from: a, to: Math.min(now, a + 30 * DAY) }));
        return n;
      });
      if (okSales) {
        ds.state.lastSalesSyncAt = now;
        if (ds.state.backfillFrom === null) ds.state.backfillFrom = from;
      }

      // 4. backfill 180 days, 1-day chunks, newest first
      const target = now - this.o.backfillDays * DAY;
      for (let i = 0; i < this.o.backfillChunksPerTick && ds.state.backfillFrom !== null && ds.state.backfillFrom > target; i++) {
        const to = ds.state.backfillFrom;
        const a = Math.max(target, to - this.o.backfillChunkDays * DAY);
        const ok = await step("GetSales (история)", async () => this.addSales(await reader.getSales({ from: a, to })));
        if (!ok) break;
        ds.state.backfillFrom = a;
      }

      // 5. product lines, newest receipts first, within the budget
      let detailed = 0;
      let failed = 0;
      for (const sale of ds.undetailed(this.o.detailsPerTick)) {
        if (Date.now() - t0 > this.o.maxTickMs) break;
        try {
          const d = await reader.getSaleById(sale.saleId);
          const positions: KsPosition[] = (d?.Positions ?? []).map((p) => ({ saleId: sale.saleId, positionId: p.PositionId, productId: p.ProductId, qty: p.Quantity, price: p.Price ?? null }));
          ds.positions.set(sale.saleId, positions);
          sale.detailed = true;
          await repo.savePositions(sale.saleId, positions);
          detailed++;
        } catch (e) {
          failed++;
          if (failed >= 5) {
            steps.push({ step: "GetSaleById", ok: false, count: detailed, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
            break;
          }
        }
      }
      if (detailed) ds.touch();
      if (!steps.some((s) => s.step === "GetSaleById")) steps.push({ step: "GetSaleById", ok: failed === 0, count: detailed });
    } catch (e) {
      steps.push({ step: "tick", ok: false, count: 0, error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.running = false;
    }
    const ok = steps.every((s) => s.ok);
    // "fresh data" = stock or receipts really came from KiT Shop in this tick
    if (steps.some((s) => s.ok && (s.step.startsWith("GetShopStocks") || s.step === "GetSales (новые)"))) ds.state.lastSuccessAt = now;
    if (!ok) {
      ds.state.lastErrorAt = now;
      ds.state.lastError = steps.filter((s) => !s.ok).map((s) => `${s.step}: ${s.error ?? "ошибка"}`).join("; ").slice(0, 400);
    } else ds.state.lastError = null;
    await repo.saveState(ds.state).catch(() => undefined);
    this.lastTick = { ok, steps, ms: Date.now() - t0, backlog: this.backlog() };
    return this.lastTick;
  }
}
