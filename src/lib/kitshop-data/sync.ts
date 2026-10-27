import type { KitShopReadOnlyClient } from "@/services/kitshop/kitshopClient";
import { parseKitshopDate } from "@/services/kitshop/transport";
import type { KsDataset, KsFillUp, KsFillUpLine, KsPosition, KsSale } from "./dataset";
import type { KsRepo } from "./repo";

/**
 * 5-minute READ-ONLY sync: KiT Shop → our database (the cache every screen reads).
 *  • catalog (GetShops + GetProducts + GetProductGroups): every 6 h or on demand;
 *  • stock (GetShopStocks) of our fridges: every tick (≥ 4.5 min apart);
 *  • new receipts (GetSales) since the last sync with a 15-min overlap — never the whole history again;
 *  • backfill of KITSHOP_BACKFILL_DAYS (180) in 1-day GetSales chunks (API limit 60 days), newest first;
 *  • product lines (GetSaleById per receipt — the only documented product-level source), newest first, budgeted;
 *  • stock HISTORY: every GetShopStocks reading is kept as a change log (a row only when a quantity changed) plus the
 *    periods it covers — needed to know when a dish was on the shelf and when it was sold out;
 *  • loads / unloads (GetFillUps, ≤ 60 days per call) of our fridges with their lines (GetFillUpById), same 180-day backfill.
 * Load on KiT Shop is limited: KITSHOP_BACKFILL_CONCURRENCY (1–2) parallel GetSaleById, KITSHOP_BACKFILL_DELAY_MS pause
 * after each history call. A failing receipt is retried later with back-off; it never stops the rest of the sync.
 * Calls only get* methods of the read-only client. Nothing in KiT Shop is ever changed.
 */

type Reader = Pick<KitShopReadOnlyClient, "getShops" | "getProducts" | "getShopStocks" | "getSales" | "getSaleById"> &
  Partial<Pick<KitShopReadOnlyClient, "getProductGroups" | "getFillUps" | "getFillUpById">>;

export interface SyncOptions {
  backfillDays: number;
  backfillChunkDays: number;
  /** backfill chunks per tick */
  backfillChunksPerTick: number;
  detailsPerTick: number;
  /** parallel GetSaleById requests (1–2) */
  concurrency: number;
  /** pause after every history request (GetSaleById / backfill GetSales), ms */
  delayMs: number;
  catalogEveryMs: number;
  stockEveryMs: number;
  salesOverlapMs: number;
  /** stop detailing when a tick has run this long */
  maxTickMs: number;
  /** consecutive GetSaleById failures that end the detail step of this tick (KiT Shop is probably down) */
  maxConsecutiveFailures: number;
  /** GetFillUps backfill: days per call and calls per tick */
  fillupChunkDays: number;
  fillupChunksPerTick: number;
  /** GetFillUpById per tick */
  fillupDetailsPerTick: number;
  /** two stock readings further apart than this = a gap in the stock history (stock unknown in between) */
  stockGapMs: number;
}

const clampInt = (v: string | undefined, def: number, min: number, max: number) => {
  const n = Math.round(Number(v));
  return v === undefined || v === "" || !Number.isFinite(n) ? def : Math.min(max, Math.max(min, n));
};

/** Defaults are deliberately gentle towards KiT Shop. */
export function syncOptionsFromEnv(env: Record<string, string | undefined> = process.env): Partial<SyncOptions> {
  return {
    backfillDays: clampInt(env.KITSHOP_BACKFILL_DAYS, 180, 1, 365),
    concurrency: clampInt(env.KITSHOP_BACKFILL_CONCURRENCY, 1, 1, 2),
    delayMs: clampInt(env.KITSHOP_BACKFILL_DELAY_MS, 300, 0, 10_000),
  };
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  backfillDays: 180,
  backfillChunkDays: 1,
  backfillChunksPerTick: 3,
  detailsPerTick: 400,
  concurrency: 1,
  delayMs: 300,
  catalogEveryMs: 6 * 3_600_000,
  stockEveryMs: 4.5 * 60_000,
  salesOverlapMs: 15 * 60_000,
  maxTickMs: 4 * 60_000,
  maxConsecutiveFailures: 5,
  fillupChunkDays: 10,
  fillupChunksPerTick: 2,
  fillupDetailsPerTick: 60,
  stockGapMs: 15 * 60_000,
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
  /** injectable for tests */
  sleep?: (ms: number) => Promise<void>;
}

export interface TickResult {
  ok: boolean;
  steps: { step: string; ok: boolean; count: number; error?: string }[];
  ms: number;
  backlog: { undetailed: number; backfillDaysLeft: number };
}

const DAY = 86_400_000;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/** Back-off for a receipt whose GetSaleById failed: 2, 4, 8 … minutes, at most 1 hour. */
export const retryDelayMs = (failures: number) => Math.min(60, 2 ** Math.max(1, failures)) * 60_000;

/** Fill-up lines from Details (list or GetFillUpById); DetailId when given, otherwise the position in the list. */
function fillUpLines(fillupId: string, details: { ProductId: string; Quantity: number; DetailId?: unknown }[] | null | undefined): KsFillUpLine[] {
  return (details ?? []).map((x, i) => ({
    fillupId,
    lineId: x.DetailId !== undefined && x.DetailId !== null ? String(x.DetailId) : `#${i}`,
    productId: x.ProductId,
    qty: Number(x.Quantity),
  }));
}

export class KitShopSync {
  readonly o: SyncOptions;
  running = false;
  lastTick: TickResult | null = null;
  private sleep: (ms: number) => Promise<void>;

  constructor(private d: SyncDeps) {
    this.o = { ...DEFAULT_SYNC_OPTIONS, ...(d.options ?? {}) };
    this.sleep = d.sleep ?? ((ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()));
  }

  backlog() {
    const target = this.d.now() - this.o.backfillDays * DAY;
    let undetailed = 0;
    for (const s of this.d.ds.sales.values()) if (!s.detailed) undetailed++;
    let fillupsUndetailed = 0;
    for (const f of this.d.ds.fillUps.values()) if (!f.detailed) fillupsUndetailed++;
    const from = this.d.ds.state.backfillFrom;
    const ff = this.d.ds.state.fillupsBackfillFrom ?? null;
    return {
      undetailed: undetailed + fillupsUndetailed,
      backfillDaysLeft: Math.max(
        from === null ? this.o.backfillDays : Math.max(0, Math.ceil((from - target) / DAY)),
        !this.d.reader.getFillUps ? 0 : ff === null ? this.o.backfillDays : Math.max(0, Math.ceil((ff - target) / DAY)),
      ),
    };
  }

  /** History progress for the admin: days done, current backfill date, receipts / items. */
  progress() {
    const b = this.backlog();
    const c = this.d.ds.counts(this.d.now());
    return {
      daysTotal: this.o.backfillDays,
      daysDone: this.o.backfillDays - b.backfillDaysLeft,
      currentBackfillDate: this.d.ds.state.backfillFrom,
      receipts: c.sales,
      receiptsDetailed: c.salesDetailed,
      receiptsRetrying: c.salesRetrying,
      receiptsPending: b.undetailed,
      items: c.positions,
      units: c.units,
      limits: { concurrency: this.o.concurrency, delayMs: this.o.delayMs, backfillDays: this.o.backfillDays },
    };
  }

  private toWall(s: string): number | null {
    const t = parseKitshopDate(s);
    return t === null ? null : t + (this.d.timeOffsetMs ?? 0);
  }

  /** Adds receipts; a SaleId already known is never stored twice (overlap / backfill re-reads are free). */
  private async addSales(rows: Awaited<ReturnType<Reader["getSales"]>>): Promise<number> {
    const { ds, repo } = this.d;
    const fresh: KsSale[] = [];
    for (const r of rows) {
      const soldAt = this.toWall(r.SaleDateTime);
      if (soldAt === null) continue;
      const cur = ds.sales.get(r.SaleId);
      if (cur && cur.soldAt === soldAt && cur.shopId === r.ShopId) continue;
      const sale: KsSale = {
        saleId: r.SaleId,
        shopId: r.ShopId,
        soldAt,
        total: r.Sum ?? null,
        detailed: cur?.detailed ?? false,
        detailFailures: cur?.detailFailures ?? 0,
        retryAt: cur?.retryAt ?? null,
      };
      ds.sales.set(sale.saleId, sale);
      fresh.push(sale);
    }
    if (fresh.length) {
      await repo.saveSales(fresh);
      ds.touch();
    }
    return fresh.length;
  }

  /** Adds fill-ups of OUR fridges; Details given in the list are kept at once (no GetFillUpById needed). */
  private async addFillUps(rows: NonNullable<Awaited<ReturnType<NonNullable<Reader["getFillUps"]>>>>): Promise<number> {
    const { ds, repo } = this.d;
    const ours = new Set(this.d.ourShopIds);
    const fresh: KsFillUp[] = [];
    for (const r of rows) {
      if (!ours.has(r.ShopId)) continue;
      const at = r.FillupDateTime ? this.toWall(r.FillupDateTime) : null;
      const cur = ds.fillUps.get(r.FillupId);
      const lines = fillUpLines(r.FillupId, r.Details);
      if (cur && cur.at === at && (cur.detailed || !lines.length)) continue;
      const f: KsFillUp = {
        fillupId: r.FillupId,
        shopId: r.ShopId,
        at,
        type: r.FillupType ?? null,
        notes: r.Notes ?? null,
        userName: r.UserName ?? null,
        detailed: cur?.detailed ?? false,
        detailFailures: cur?.detailFailures ?? 0,
        retryAt: cur?.retryAt ?? null,
      };
      ds.fillUps.set(f.fillupId, f);
      fresh.push(f);
      if (!f.detailed && lines.length) {
        await repo.saveFillUps([f]);
        ds.fillUpLines.set(f.fillupId, lines);
        f.detailed = true;
        await repo.saveFillUpLines(f.fillupId, lines);
      }
    }
    if (fresh.length) {
      await repo.saveFillUps(fresh);
      ds.touch();
    }
    return fresh.length;
  }

  /** GetFillUpById for fill-ups without lines, newest first, within the per-tick budget. */
  private async detailFillUps(t0: number, now: number): Promise<{ detailed: number; failed: number }> {
    const { reader, repo, ds } = this.d;
    const getById = reader.getFillUpById?.bind(reader);
    if (!getById) return { detailed: 0, failed: 0 };
    let detailed = 0;
    let failed = 0;
    let consecutive = 0;
    for (const f of ds.undetailedFillUps(this.o.fillupDetailsPerTick, now)) {
      if (Date.now() - t0 > this.o.maxTickMs || consecutive >= this.o.maxConsecutiveFailures) break;
      try {
        const d = await getById(f.fillupId);
        const lines = fillUpLines(f.fillupId, d?.Details);
        ds.fillUpLines.set(f.fillupId, lines);
        if (d?.Notes && !f.notes) f.notes = d.Notes;
        f.detailed = true;
        f.retryAt = null;
        await repo.saveFillUpLines(f.fillupId, lines);
        detailed++;
        consecutive = 0;
      } catch {
        failed++;
        consecutive++;
        f.detailFailures = (f.detailFailures ?? 0) + 1;
        f.retryAt = now + retryDelayMs(f.detailFailures);
        await repo.markFillUpFailed(f.fillupId, f.detailFailures, f.retryAt).catch(() => undefined);
      }
      await this.sleep(this.o.delayMs);
    }
    return { detailed, failed };
  }

  /** GetSaleById for a batch of receipts with limited concurrency; failures are recorded per receipt. */
  private async detail(batch: KsSale[], t0: number, now: number): Promise<{ detailed: number; failed: number; stoppedBy: string | null }> {
    const { reader, repo, ds } = this.d;
    let next = 0;
    let detailed = 0;
    let failed = 0;
    let consecutive = 0;
    let stoppedBy: string | null = null;
    const worker = async () => {
      while (next < batch.length && !stoppedBy) {
        if (Date.now() - t0 > this.o.maxTickMs) return;
        const sale = batch[next++];
        try {
          const d = await reader.getSaleById(sale.saleId);
          const positions: KsPosition[] = (d?.Positions ?? []).map((p) => ({ saleId: sale.saleId, positionId: p.PositionId, productId: p.ProductId, qty: p.Quantity, price: p.Price ?? null }));
          ds.positions.set(sale.saleId, positions);
          sale.detailed = true;
          sale.retryAt = null;
          await repo.savePositions(sale.saleId, positions);
          detailed++;
          consecutive = 0;
        } catch (e) {
          failed++;
          consecutive++;
          sale.detailFailures = (sale.detailFailures ?? 0) + 1;
          sale.retryAt = now + retryDelayMs(sale.detailFailures);
          await repo.markDetailFailed(sale.saleId, sale.detailFailures, sale.retryAt).catch(() => undefined);
          if (consecutive >= this.o.maxConsecutiveFailures) stoppedBy = errText(e);
        }
        await this.sleep(this.o.delayMs);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(2, this.o.concurrency)) }, worker));
    return { detailed, failed, stoppedBy };
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
        steps.push({ step: name, ok: false, count: 0, error: errText(e) });
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
        // product groups = the category as KiT Shop knows it (optional: without them the name classifier is used)
        if (reader.getProductGroups) {
          const getGroups = reader.getProductGroups.bind(reader);
          await step("GetProductGroups", async () => {
            const groups = await getGroups();
            for (const g of groups) ds.groups.set(g.GroupId, { groupId: g.GroupId, name: g.GroupName });
            await repo.saveGroups([...ds.groups.values()]);
            return groups.length;
          });
        }
        if (okShops && okProducts) ds.state.lastCatalogSyncAt = now;
        ds.touch();
        if (!okShops && !ds.shops.size) throw new Error(steps.find((s) => s.step === "GetShops")?.error ?? "KiT Shop недоступен");
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
            // stock history (change log) before the current stock is replaced
            const rec = ds.recordStock(shopId, m, now, this.o.stockGapMs);
            ds.stock.set(shopId, m);
            ds.stockAt.set(shopId, now);
            await repo.replaceStock(shopId, [...m.entries()].map(([productId, qty]) => ({ shopId, productId, qty })), now);
            await repo.saveStockChanges(shopId, rec.changes, now, rec.coverage);
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
      // 3b. new loads / unloads of our fridges (same overlap idea)
      const getFillUps = reader.getFillUps?.bind(reader);
      if (getFillUps) {
        const ffrom = ds.state.lastFillupsSyncAt !== null ? ds.state.lastFillupsSyncAt - this.o.salesOverlapMs : now - DAY;
        const okFill = await step("GetFillUps (новые)", async () => {
          let n = 0;
          for (let a = ffrom; a < now; a += 30 * DAY) n += await this.addFillUps(await getFillUps({ from: a, to: Math.min(now, a + 30 * DAY) }));
          return n;
        });
        if (okFill) {
          ds.state.lastFillupsSyncAt = now;
          if ((ds.state.fillupsBackfillFrom ?? null) === null) ds.state.fillupsBackfillFrom = ffrom;
        }
      }

      // fresh stock / receipts are on screen right away — the long history steps below must not delay it
      if (steps.some((s) => s.ok && (s.step.startsWith("GetShopStocks") || s.step === "GetSales (новые)"))) {
        ds.state.lastSuccessAt = now;
        ds.touch();
        await repo.saveState(ds.state).catch(() => undefined);
      }

      // 4. backfill, 1-day chunks, newest first — continues from the persisted backfillFrom after a restart
      const target = now - this.o.backfillDays * DAY;
      for (let i = 0; i < this.o.backfillChunksPerTick && ds.state.backfillFrom !== null && ds.state.backfillFrom > target; i++) {
        const to = ds.state.backfillFrom;
        const a = Math.max(target, to - this.o.backfillChunkDays * DAY);
        const ok = await step("GetSales (история)", async () => this.addSales(await reader.getSales({ from: a, to })));
        if (!ok) break;
        ds.state.backfillFrom = a;
        await this.sleep(this.o.delayMs);
      }

      // 4b. loads / unloads history, newest first, then their lines
      if (getFillUps) {
        for (let i = 0; i < this.o.fillupChunksPerTick && (ds.state.fillupsBackfillFrom ?? null) !== null && ds.state.fillupsBackfillFrom! > target; i++) {
          const to = ds.state.fillupsBackfillFrom!;
          const a = Math.max(target, to - this.o.fillupChunkDays * DAY);
          const ok = await step("GetFillUps (история)", async () => this.addFillUps(await getFillUps({ from: a, to })));
          if (!ok) break;
          ds.state.fillupsBackfillFrom = a;
          await this.sleep(this.o.delayMs);
        }
        const fr = await this.detailFillUps(t0, now);
        if (fr.detailed || fr.failed) {
          ds.touch();
          steps.push({ step: "GetFillUpById", ok: fr.failed < this.o.maxConsecutiveFailures, count: fr.detailed, error: fr.failed ? `${fr.failed} операций отложено для повтора` : undefined });
        }
      }

      // 5. product lines, newest receipts first, within the budget; failed receipts wait for their retry time
      const res = await this.detail(ds.undetailed(this.o.detailsPerTick, now), t0, now);
      if (res.detailed) ds.touch();
      steps.push({
        step: "GetSaleById",
        // single failing receipts are retried later — only a run of failures (KiT Shop down) fails the step
        ok: res.stoppedBy === null,
        count: res.detailed,
        error: res.stoppedBy ? `${res.failed} ошибок подряд: ${res.stoppedBy}` : res.failed ? `${res.failed} чеков отложено для повтора` : undefined,
      });
    } catch (e) {
      steps.push({ step: "tick", ok: false, count: 0, error: errText(e) });
    } finally {
      this.running = false;
    }
    const ok = steps.every((s) => s.ok);
    // "fresh data" = stock or receipts really came from KiT Shop in this tick
    if (steps.some((s) => s.ok && (s.step.startsWith("GetShopStocks") || s.step === "GetSales (новые)"))) ds.state.lastSuccessAt = now;
    const failedSteps = steps.filter((s) => !s.ok);
    if (failedSteps.length) {
      ds.state.lastErrorAt = now;
      ds.state.lastError = failedSteps.map((s) => `${s.step}: ${s.error ?? "ошибка"}`).join("; ").slice(0, 400);
      ds.state.errors = [...(ds.state.errors ?? []), ...failedSteps.map((s) => ({ at: now, step: s.step, error: s.error ?? "ошибка" }))].slice(-100);
    } else ds.state.lastError = null;
    await repo.saveState(ds.state).catch(() => undefined);
    this.lastTick = { ok, steps, ms: Date.now() - t0, backlog: this.backlog() };
    return this.lastTick;
  }
}
