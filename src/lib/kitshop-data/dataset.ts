/**
 * Real KiT Shop data as Apps Холодосов keeps it (read-only copy, our database is the cache).
 * Filled by the 5-minute sync; the analytics snapshot is built from it. Times are wall-clock ms ("UTC fields = local").
 */

export interface KsShop {
  shopId: string;
  name: string;
  stocksAccounting: boolean | null;
}

export interface KsProduct {
  productId: string;
  name: string;
  barcode: string | null;
  vendorCode: string | null;
  price: number | null;
  groupId: number | null;
}

export interface KsGroup {
  groupId: number;
  name: string;
}

export interface KsSale {
  saleId: string;
  shopId: string;
  soldAt: number;
  total: number | null;
  /** positions loaded through GetSaleById */
  detailed: boolean;
  /** failed GetSaleById attempts (the receipt is retried later, the sync goes on) */
  detailFailures?: number;
  /** wall-clock ms before which the receipt is not retried */
  retryAt?: number | null;
}

export interface KsPosition {
  saleId: string;
  positionId: string;
  productId: string;
  qty: number;
  price: number | null;
}

export interface KsStock {
  shopId: string;
  productId: string;
  qty: number;
}

export interface KsSyncError {
  at: number;
  step: string;
  error: string;
}

/** Sync bookkeeping — persisted, so a restart never re-downloads history. */
export interface KsSyncState {
  lastCatalogSyncAt: number | null;
  lastStockSyncAt: number | null;
  lastSalesSyncAt: number | null;
  lastFillupsSyncAt: number | null;
  /** oldest wall-clock ms already listed through GetSales (backfill goes back to now − KITSHOP_BACKFILL_DAYS) */
  backfillFrom: number | null;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  /** last 100 errors (admin: errors in the last 24 h) */
  errors?: KsSyncError[];
}

export const emptySyncState = (): KsSyncState => ({
  lastCatalogSyncAt: null,
  lastStockSyncAt: null,
  lastSalesSyncAt: null,
  lastFillupsSyncAt: null,
  backfillFrom: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  errors: [],
});

export class KsDataset {
  shops = new Map<string, KsShop>();
  products = new Map<string, KsProduct>();
  groups = new Map<number, KsGroup>();
  sales = new Map<string, KsSale>();
  /** saleId → positions */
  positions = new Map<string, KsPosition[]>();
  /** shopId → productId → qty */
  stock = new Map<string, Map<string, number>>();
  stockAt = new Map<string, number>();
  state: KsSyncState = emptySyncState();
  /** bumped on every change (snapshot cache key) */
  version = 0;

  touch() {
    this.version++;
  }

  /** Receipts still without product lines, newest first; ones waiting for a retry are skipped until retryAt. */
  undetailed(limit: number, now = Infinity): KsSale[] {
    const out: KsSale[] = [];
    for (const s of this.sales.values()) if (!s.detailed && (s.retryAt ?? 0) <= now) out.push(s);
    // newest first: recent days become useful before the old backfill finishes
    return out.sort((a, b) => b.soldAt - a.soldAt).slice(0, limit);
  }

  counts(now?: number) {
    let detailed = 0;
    let retrying = 0;
    let positions = 0;
    let units = 0;
    let last24h = 0;
    for (const s of this.sales.values()) {
      if (s.detailed) detailed++;
      else if ((s.detailFailures ?? 0) > 0) retrying++;
      if (now !== undefined && s.soldAt > now - 86_400_000 && s.soldAt <= now) last24h++;
    }
    for (const list of this.positions.values()) {
      positions += list.length;
      for (const p of list) units += p.qty;
    }
    let stockRows = 0;
    for (const m of this.stock.values()) stockRows += m.size;
    let oldest: number | null = null;
    let newest: number | null = null;
    for (const s of this.sales.values()) {
      if (oldest === null || s.soldAt < oldest) oldest = s.soldAt;
      if (newest === null || s.soldAt > newest) newest = s.soldAt;
    }
    return {
      shops: this.shops.size,
      products: this.products.size,
      groups: this.groups.size,
      sales: this.sales.size,
      salesDetailed: detailed,
      salesRetrying: retrying,
      salesLast24h: last24h,
      positions,
      units: Math.round(units),
      stockRows,
      oldestSale: oldest,
      newestSale: newest,
    };
  }
}
