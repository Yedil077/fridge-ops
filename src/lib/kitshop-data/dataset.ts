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

/** A load / unload operation (GetFillUps §3.19 + GetFillUpById §3.12). Type 1 load, 2 unload, 3 mixed. */
export interface KsFillUp {
  fillupId: string;
  shopId: string;
  /** wall-clock ms; null when KiT Shop gave no time (then it cannot be placed on the timeline) */
  at: number | null;
  type: number | null;
  notes: string | null;
  userName: string | null;
  /** lines loaded (GetFillUpById or Details in the list) */
  detailed: boolean;
  detailFailures?: number;
  retryAt?: number | null;
}

/** One line of a fill-up: quantity > 0 loaded, < 0 taken out. */
export interface KsFillUpLine {
  fillupId: string;
  lineId: string;
  productId: string;
  qty: number;
}

/** Stock history is a change log: a row only when the quantity of a dish changed (incl. to 0). */
export interface KsStockChange {
  at: number;
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
  /** oldest wall-clock ms already listed through GetFillUps (fill-up backfill, like backfillFrom for receipts) */
  fillupsBackfillFrom?: number | null;
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
  fillupsBackfillFrom: null,
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
  fillUps = new Map<string, KsFillUp>();
  /** fillupId → lines */
  fillUpLines = new Map<string, KsFillUpLine[]>();
  /** shopId → productId → changes (ascending time): GetShopStocks every 5 minutes, written only when a quantity changed */
  stockHistory = new Map<string, Map<string, KsStockChange[]>>();
  /** shopId → [from, to] periods in which stock was read every 5 minutes (gaps = sync was down, stock unknown) */
  stockCoverage = new Map<string, [number, number][]>();
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

  /** Fill-ups still without lines, newest first; ones waiting for a retry are skipped until retryAt. */
  undetailedFillUps(limit: number, now = Infinity): KsFillUp[] {
    const out: KsFillUp[] = [];
    for (const f of this.fillUps.values()) if (!f.detailed && (f.retryAt ?? 0) <= now) out.push(f);
    return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, limit);
  }

  /** Records one GetShopStocks reading: appends changed quantities, extends (or opens) the 5-minute coverage period. */
  recordStock(shopId: string, next: Map<string, number>, at: number, gapMs: number): { changes: { productId: string; qty: number }[]; coverage: [number, number] } {
    const cov = this.stockCoverage.get(shopId) ?? [];
    const last = cov[cov.length - 1];
    const continues = !!last && at - last[1] <= gapMs && at >= last[1];
    const hist = this.stockHistory.get(shopId) ?? new Map<string, { at: number; qty: number }[]>();
    const changes: { productId: string; qty: number }[] = [];
    const lastQty = (pid: string) => {
      const h = hist.get(pid);
      return h && h.length ? h[h.length - 1].qty : 0;
    };
    if (continues) {
      // inside a period: only what changed (a dish that disappeared → 0)
      for (const pid of new Set([...hist.keys(), ...next.keys()])) {
        const q = next.get(pid) ?? 0;
        if (q !== lastQty(pid)) changes.push({ productId: pid, qty: q });
      }
    } else {
      // a new period starts with the full state (everything not listed is 0)
      for (const [pid, q] of next) if (q > 0) changes.push({ productId: pid, qty: q });
      for (const pid of hist.keys()) if (!next.has(pid) && lastQty(pid) !== 0) changes.push({ productId: pid, qty: 0 });
    }
    for (const c of changes) {
      const h = hist.get(c.productId) ?? [];
      h.push({ at, qty: c.qty });
      hist.set(c.productId, h);
    }
    this.stockHistory.set(shopId, hist);
    let coverage: [number, number];
    if (continues) {
      last[1] = at;
      coverage = last;
    } else {
      coverage = [at, at];
      cov.push(coverage);
    }
    this.stockCoverage.set(shopId, cov);
    return { changes, coverage };
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
