import "server-only";
import { KitShopReadOnlyClient } from "@/services/kitshop/kitshopClient";

/**
 * Background sync (Phase 2). Pulls data from KitShop READ-ONLY and stores it in OUR database.
 *
 *  • incremental: sales are requested only for (last_sync_at − overlap, now];
 *  • idempotent: rows are upserted by external_sale_id, so the overlap never duplicates;
 *  • first run backfills history in daily chunks (180 days), never one giant request;
 *  • never writes to KitShop.
 *
 * Persistence of synced rows arrives with Prisma in Phase 2 (see prisma/schema.prisma);
 * the `SalesSink` interface below is what the database layer will implement.
 */

export interface SyncState {
  lastSalesSyncAt: string | null;
  lastStockSyncAt: string | null;
}

export interface SalesSink {
  upsertSales(rows: Awaited<ReturnType<KitShopReadOnlyClient["getSalesByShops"]>>): Promise<number>;
  replaceStocks(rows: Awaited<ReturnType<KitShopReadOnlyClient["getStocks"]>>): Promise<number>;
  getState(): Promise<SyncState>;
  setState(state: SyncState): Promise<void>;
}

const OVERLAP_MS = 15 * 60_000;
const BACKFILL_DAYS = 180;
const DAY_MS = 86_400_000;

export async function runSync(client: KitShopReadOnlyClient, sink: SalesSink, now = new Date()): Promise<{ sales: number; stocks: number }> {
  const state = await sink.getState();
  let sales = 0;
  const end = now.getTime();
  let from = state.lastSalesSyncAt ? Date.parse(state.lastSalesSyncAt) - OVERLAP_MS : end - BACKFILL_DAYS * DAY_MS;
  // chunk by day so a backfill is many small requests
  while (from < end) {
    const to = Math.min(end, from + DAY_MS);
    const rows = await client.getSalesByShops({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
    sales += await sink.upsertSales(rows);
    await sink.setState({ ...state, lastSalesSyncAt: new Date(to).toISOString() });
    from = to;
  }
  const stocks = await sink.replaceStocks(await client.getStocks());
  await sink.setState({ lastSalesSyncAt: new Date(end).toISOString(), lastStockSyncAt: new Date(end).toISOString() });
  return { sales, stocks };
}
