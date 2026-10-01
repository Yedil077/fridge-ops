import "server-only";
import type { KitShopReadOnlyClient } from "@/services/kitshop/kitshopClient";
import type { KitShopSale, KitShopStock } from "@/services/kitshop/types";

/**
 * Background sync (Phase C+). Pulls data from KitShop READ-ONLY and stores it in OUR database.
 *
 *  • incremental: sales are requested only for (last_sync_at − overlap, now];
 *  • idempotent: rows are upserted by SaleId, so the overlap never duplicates;
 *  • first run backfills history in daily chunks (180 days), never one giant request (limit: 60 days);
 *  • stock is read per shop (GetShopStocks takes one shop Id);
 *  • never writes to KitShop.
 * GetSales returns receipts without items; product lines need GetSaleById per sale or GetSalesByProducts.
 */

export interface SyncState {
  lastSalesSyncAt: number | null;
  lastStockSyncAt: number | null;
}

export interface SalesSink {
  upsertSales(rows: KitShopSale[]): Promise<number>;
  replaceStocks(shopId: string, rows: KitShopStock[]): Promise<number>;
  getState(): Promise<SyncState>;
  setState(state: SyncState): Promise<void>;
}

const OVERLAP_MS = 15 * 60_000;
const BACKFILL_DAYS = 180;
const DAY_MS = 86_400_000;

/** `now` is wall-clock ms in the fridges' timezone (KiT Shop dates are local). */
export async function runSync(client: KitShopReadOnlyClient, sink: SalesSink, shopIds: string[], now: number): Promise<{ sales: number; stocks: number }> {
  const state = await sink.getState();
  let sales = 0;
  let from = state.lastSalesSyncAt ? state.lastSalesSyncAt - OVERLAP_MS : now - BACKFILL_DAYS * DAY_MS;
  while (from < now) {
    const to = Math.min(now, from + DAY_MS);
    sales += await sink.upsertSales(await client.getSales({ from, to }));
    await sink.setState({ ...state, lastSalesSyncAt: to });
    from = to;
  }
  let stocks = 0;
  for (const shopId of shopIds) stocks += await sink.replaceStocks(shopId, await client.getShopStocks(shopId));
  await sink.setState({ lastSalesSyncAt: now, lastStockSyncAt: now });
  return { sales, stocks };
}
