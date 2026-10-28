import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { serializeCache, deserializeCache, type AnalyticsCache, type ShopAnalytics } from "./analytics";
import { dsHistory, type HistorySource, type ShopHistory } from "./history";
import { KsDataset, emptySyncState, type KsFillUp, type KsFillUpLine, type KsGroup, type KsPosition, type KsProduct, type KsSale, type KsShop, type KsStock, type KsSyncState } from "./dataset";

/**
 * Persistence of the KiT Shop read-only copy.
 *  • PgKsRepo  — production (PostgreSQL tables ks_*), survives restarts, never re-downloads history;
 *  • FileKsRepo — local development (.data/kitshop.json);
 *  • MemoryKsRepo — tests.
 * Only OUR database is written here. KiT Shop itself is never modified.
 */
export interface KsRepo {
  readonly kind: "postgres" | "file" | "memory";
  load(ds: KsDataset): Promise<void>;
  saveShops(shops: KsShop[]): Promise<void>;
  saveProducts(products: KsProduct[]): Promise<void>;
  saveGroups(groups: KsGroup[]): Promise<void>;
  replaceStock(shopId: string, rows: KsStock[], at: number): Promise<void>;
  saveSales(sales: KsSale[]): Promise<void>;
  savePositions(saleId: string, positions: KsPosition[]): Promise<void>;
  /** GetSaleById failed for this receipt: remember the attempt, retry after retryAt */
  markDetailFailed(saleId: string, failures: number, retryAt: number): Promise<void>;
  saveState(state: KsSyncState): Promise<void>;
  /** fill-up headers (GetFillUps); `detailed` of a stored fill-up is never reset */
  saveFillUps(rows: KsFillUp[]): Promise<void>;
  /** lines of one fill-up (GetFillUpById) → it becomes detailed */
  saveFillUpLines(fillupId: string, lines: KsFillUpLine[]): Promise<void>;
  markFillUpFailed(fillupId: string, failures: number, retryAt: number): Promise<void>;
  /** stock history: changed quantities at `at` + the 5-minute coverage period they belong to */
  saveStockChanges(shopId: string, changes: { productId: string; qty: number }[], at: number, coverage: [number, number]): Promise<void>;

  /** where the history is read (PostgreSQL: SQL per shop / dish; others: the in-memory dataset) */
  history(ds: KsDataset): HistorySource;
  /** receipts / fill-ups still without lines, newest first (the queue of GetSaleById / GetFillUpById) */
  undetailedSales(ds: KsDataset, limit: number, now: number): Promise<KsSale[]>;
  undetailedFillUps(ds: KsDataset, limit: number, now: number): Promise<KsFillUp[]>;
  /** totals for the admin and the completeness of the copy */
  stats(ds: KsDataset, settleBefore: number): Promise<RepoStats>;
  /** the nightly analytics result */
  saveShopAnalytics(s: ShopAnalytics, day: number): Promise<void>;
  saveAnalytics(c: AnalyticsCache): Promise<void>;
  loadAnalytics(): Promise<AnalyticsCache | null>;
  /** Завтра: menu and the plan per date ("YYYY-MM-DD") */
  getMenu(date: string): Promise<MenuRow[]>;
  setMenu(date: string, add: { productId: string; source: string }[], remove: string[], by: string): Promise<void>;
  getPlan(date: string): Promise<PlanRow[]>;
  upsertRecommendations(date: string, rows: Omit<PlanRow, "manualQty" | "manualBy" | "manualAt">[]): Promise<void>;
  setManual(date: string, shopId: string, productId: string, qty: number | null, by: string): Promise<void>;
}

export interface RepoStats {
  receipts: number;
  receiptsDetailed: number;
  receiptsUndetailed: number;
  receiptsRetrying: number;
  positions: number;
  units: number;
  fillUps: number;
  fillUpsUndetailed: number;
  stockRows: number;
  oldestSale: number | null;
  newestSale: number | null;
  newestUndetailedSale: number | null;
  newestUndetailedFillUp: number | null;
  /** rows of history that stay in the database (not in memory) */
  historyRowsInDb: number;
}

export interface MenuRow {
  productId: string;
  source: string;
  addedBy: string;
  addedAt: number;
}

export interface PlanRow {
  shopId: string;
  productId: string;
  recommendedQty: number | null;
  recMin: number | null;
  recMax: number | null;
  expectedLeft: number;
  confidence: string;
  reason: unknown;
  manualQty: number | null;
  manualBy: string | null;
  manualAt: number | null;
  updatedAt: number;
}

/** Memory / file repos: the same operations on the in-memory dataset (development, tests). */
abstract class InMemoryOps {
  protected analytics: AnalyticsCache | null = null;
  protected menus = new Map<string, MenuRow[]>();
  protected plans = new Map<string, Map<string, PlanRow>>();
  history(ds: KsDataset): HistorySource {
    return dsHistory(ds);
  }
  async undetailedSales(ds: KsDataset, limit: number, now: number) {
    return ds.undetailed(limit, now);
  }
  async undetailedFillUps(ds: KsDataset, limit: number, now: number) {
    return ds.undetailedFillUps(limit, now);
  }
  async stats(ds: KsDataset, settleBefore: number): Promise<RepoStats> {
    const c = ds.counts(settleBefore);
    let newestUndetailedSale: number | null = null;
    let retrying = 0;
    for (const s of ds.sales.values())
      if (!s.detailed) {
        if ((s.detailFailures ?? 0) > 0) retrying++;
        if (s.soldAt < settleBefore && (newestUndetailedSale === null || s.soldAt > newestUndetailedSale)) newestUndetailedSale = s.soldAt;
      }
    let newestUndetailedFillUp: number | null = null;
    let fillUpsUndetailed = 0;
    for (const f of ds.fillUps.values())
      if (!f.detailed) {
        fillUpsUndetailed++;
        if (f.at !== null && f.at < settleBefore && (newestUndetailedFillUp === null || f.at > newestUndetailedFillUp)) newestUndetailedFillUp = f.at;
      }
    return {
      receipts: c.sales,
      receiptsDetailed: c.salesDetailed,
      receiptsUndetailed: c.sales - c.salesDetailed,
      receiptsRetrying: retrying,
      positions: c.positions,
      units: c.units,
      fillUps: ds.fillUps.size,
      fillUpsUndetailed,
      stockRows: c.stockRows,
      oldestSale: c.oldestSale,
      newestSale: c.newestSale,
      newestUndetailedSale,
      newestUndetailedFillUp,
      historyRowsInDb: 0,
    };
  }
  async saveShopAnalytics() {}
  async saveAnalytics(c: AnalyticsCache) {
    this.analytics = c;
    this.persist();
  }
  async loadAnalytics() {
    return this.analytics;
  }
  async getMenu(date: string) {
    return this.menus.get(date) ?? [];
  }
  async setMenu(date: string, add: { productId: string; source: string }[], remove: string[], by: string) {
    const cur = (this.menus.get(date) ?? []).filter((m) => !remove.includes(m.productId));
    for (const a of add) if (!cur.some((m) => m.productId === a.productId)) cur.push({ productId: a.productId, source: a.source, addedBy: by, addedAt: Date.now() });
    this.menus.set(date, cur);
    this.persist();
  }
  async getPlan(date: string) {
    return [...(this.plans.get(date)?.values() ?? [])];
  }
  async upsertRecommendations(date: string, rows: Omit<PlanRow, "manualQty" | "manualBy" | "manualAt">[]) {
    const m = this.plans.get(date) ?? new Map<string, PlanRow>();
    for (const r of rows) {
      const k = `${r.shopId}|${r.productId}`;
      const cur = m.get(k);
      m.set(k, { ...r, manualQty: cur?.manualQty ?? null, manualBy: cur?.manualBy ?? null, manualAt: cur?.manualAt ?? null });
    }
    this.plans.set(date, m);
    this.persist();
  }
  async setManual(date: string, shopId: string, productId: string, qty: number | null, by: string) {
    const m = this.plans.get(date) ?? new Map<string, PlanRow>();
    const k = `${shopId}|${productId}`;
    const cur = m.get(k) ?? { shopId, productId, recommendedQty: null, recMin: null, recMax: null, expectedLeft: 0, confidence: "LOW", reason: null, manualQty: null, manualBy: null, manualAt: null, updatedAt: Date.now() };
    m.set(k, { ...cur, manualQty: qty, manualBy: qty === null ? null : by, manualAt: qty === null ? null : Date.now() });
    this.plans.set(date, m);
    this.persist();
  }
  protected persist() {}
}

export class MemoryKsRepo extends InMemoryOps implements KsRepo {
  readonly kind = "memory" as const;
  async load() {}
  async saveShops() {}
  async saveProducts() {}
  async saveGroups() {}
  async replaceStock() {}
  async saveSales() {}
  async savePositions() {}
  async markDetailFailed() {}
  async saveState() {}
  async saveFillUps() {}
  async saveFillUpLines() {}
  async markFillUpFailed() {}
  async saveStockChanges() {}
}

// ───────────────────────── PostgreSQL ─────────────────────────

const DDL = `
CREATE TABLE IF NOT EXISTS ks_shops (
  shop_id BIGINT PRIMARY KEY, name TEXT NOT NULL, stocks_accounting BOOLEAN, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ks_products (
  product_id BIGINT PRIMARY KEY, name TEXT NOT NULL, barcode TEXT, vendor_code TEXT, price NUMERIC, group_id INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ks_sales (
  sale_id BIGINT PRIMARY KEY, shop_id BIGINT NOT NULL, sold_at BIGINT NOT NULL, total NUMERIC, detailed BOOLEAN NOT NULL DEFAULT false
);
ALTER TABLE ks_sales ADD COLUMN IF NOT EXISTS detail_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ks_sales ADD COLUMN IF NOT EXISTS retry_at BIGINT;
CREATE INDEX IF NOT EXISTS ks_sales_sold_at ON ks_sales (sold_at);
CREATE TABLE IF NOT EXISTS ks_groups (group_id INTEGER PRIMARY KEY, name TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ks_positions (
  sale_id BIGINT NOT NULL, position_id BIGINT NOT NULL, product_id BIGINT NOT NULL, qty NUMERIC NOT NULL, price NUMERIC,
  PRIMARY KEY (sale_id, position_id)
);
CREATE TABLE IF NOT EXISTS ks_stock (
  shop_id BIGINT NOT NULL, product_id BIGINT NOT NULL, qty NUMERIC NOT NULL, synced_at BIGINT NOT NULL,
  PRIMARY KEY (shop_id, product_id)
);
CREATE TABLE IF NOT EXISTS ks_fillups (
  fillup_id BIGINT PRIMARY KEY, shop_id BIGINT NOT NULL, at BIGINT, type INTEGER, notes TEXT, user_name TEXT,
  detailed BOOLEAN NOT NULL DEFAULT false, detail_failures INTEGER NOT NULL DEFAULT 0, retry_at BIGINT
);
CREATE TABLE IF NOT EXISTS ks_fillup_lines (
  fillup_id BIGINT NOT NULL, line_id TEXT NOT NULL, product_id BIGINT NOT NULL, qty NUMERIC NOT NULL, PRIMARY KEY (fillup_id, line_id)
);
CREATE TABLE IF NOT EXISTS ks_stock_history (
  shop_id BIGINT NOT NULL, product_id BIGINT NOT NULL, captured_at BIGINT NOT NULL, quantity NUMERIC NOT NULL,
  PRIMARY KEY (shop_id, product_id, captured_at)
);
CREATE INDEX IF NOT EXISTS ks_stock_history_at ON ks_stock_history (captured_at);
CREATE TABLE IF NOT EXISTS ks_stock_coverage (
  shop_id BIGINT NOT NULL, from_at BIGINT NOT NULL, to_at BIGINT NOT NULL, PRIMARY KEY (shop_id, from_at)
);
CREATE INDEX IF NOT EXISTS ks_sales_shop_time ON ks_sales (shop_id, sold_at);
CREATE INDEX IF NOT EXISTS ks_sales_undetailed ON ks_sales (sold_at DESC) WHERE NOT detailed;
CREATE INDEX IF NOT EXISTS ks_fillups_shop_time ON ks_fillups (shop_id, at);
CREATE INDEX IF NOT EXISTS ks_fillups_undetailed ON ks_fillups (at DESC) WHERE NOT detailed;
CREATE TABLE IF NOT EXISTS analytics_cache (id INTEGER PRIMARY KEY, run_at BIGINT NOT NULL, data TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS product_shop_daily (
  date DATE NOT NULL, shop_id BIGINT NOT NULL, product_id BIGINT NOT NULL,
  delivered_qty NUMERIC NOT NULL, sold_qty NUMERIC NOT NULL, removed_qty NUMERIC NOT NULL, writeoff_qty NUMERIC NOT NULL,
  closing_stock NUMERIC, sell_through NUMERIC, had_stock BOOLEAN NOT NULL, data_quality TEXT NOT NULL,
  PRIMARY KEY (shop_id, product_id, date)
);
CREATE TABLE IF NOT EXISTS product_shop_stats (
  shop_id BIGINT NOT NULL, product_id BIGINT NOT NULL,
  sales_7d INTEGER NOT NULL, sales_14d INTEGER NOT NULL, sales_30d INTEGER NOT NULL, sales_60d INTEGER NOT NULL, sales_180d INTEGER NOT NULL,
  deliveries_count INTEGER NOT NULL, avg_delivery_qty NUMERIC, median_delivery_qty INTEGER,
  avg_sold_per_delivery NUMERIC, median_sold_per_delivery INTEGER,
  writeoff_rate NUMERIC, removal_rate NUMERIC, sell_through_rate NUMERIC,
  recommended_min INTEGER, recommended_qty INTEGER, recommended_max INTEGER,
  confidence TEXT NOT NULL, status TEXT NOT NULL, detail JSONB NOT NULL, updated_at BIGINT NOT NULL,
  PRIMARY KEY (shop_id, product_id)
);
CREATE TABLE IF NOT EXISTS tomorrow_menu (
  date DATE NOT NULL, product_id BIGINT NOT NULL, source TEXT NOT NULL, added_by TEXT NOT NULL, added_at BIGINT NOT NULL,
  PRIMARY KEY (date, product_id)
);
CREATE TABLE IF NOT EXISTS tomorrow_plan (
  date DATE NOT NULL, shop_id BIGINT NOT NULL, product_id BIGINT NOT NULL,
  recommended_qty INTEGER, rec_min INTEGER, rec_max INTEGER, expected_left INTEGER NOT NULL, confidence TEXT NOT NULL, reason JSONB,
  manual_qty INTEGER, manual_by TEXT, manual_at BIGINT, updated_at BIGINT NOT NULL,
  PRIMARY KEY (date, shop_id, product_id)
);
CREATE TABLE IF NOT EXISTS ks_sync_state (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
`;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export class PgKsRepo implements KsRepo {
  readonly kind = "postgres" as const;
  private ready: Promise<void>;

  constructor(private pool: Pool) {
    this.ready = pool.query(DDL).then(() => undefined);
  }

  /**
   * Production start: ONLY what the day needs goes to memory — catalog, current stock, sync state, the last
   * KsDataset.KEEP_DAYS days of receipts / loads, the last stock quantity per dish. The 180-day history stays here and
   * is read per shop / dish (history()).
   */
  async load(ds: KsDataset) {
    await this.ready;
    ds.slim = true;
    // stock history older than 200 days is not used by any analysis
    await this.pool.query("DELETE FROM ks_stock_history WHERE captured_at < (SELECT max(captured_at) FROM ks_stock_history) - 200::bigint * 86400000");
    const newest = await this.pool.query("SELECT max(sold_at) AS m FROM ks_sales");
    const since = Number(newest.rows[0]?.m ?? 0) - KsDataset.KEEP_DAYS * 86_400_000;
    const [shops, products, sales, positions, stock, state, groups, fillUps, fillUpLines, stockHistory, coverage] = await Promise.all([
      this.pool.query("SELECT shop_id, name, stocks_accounting FROM ks_shops"),
      this.pool.query("SELECT product_id, name, barcode, vendor_code, price, group_id FROM ks_products"),
      this.pool.query("SELECT sale_id, shop_id, sold_at, total, detailed, detail_failures, retry_at FROM ks_sales WHERE sold_at >= $1", [since]),
      this.pool.query("SELECT p.sale_id, p.position_id, p.product_id, p.qty, p.price FROM ks_positions p JOIN ks_sales s ON s.sale_id = p.sale_id WHERE s.sold_at >= $1", [since]),
      this.pool.query("SELECT shop_id, product_id, qty, synced_at FROM ks_stock"),
      this.pool.query("SELECT value FROM ks_sync_state WHERE key = 'sync'"),
      this.pool.query("SELECT group_id, name FROM ks_groups"),
      this.pool.query("SELECT fillup_id, shop_id, at, type, notes, user_name, detailed, detail_failures, retry_at FROM ks_fillups WHERE at >= $1", [since]),
      this.pool.query("SELECT l.fillup_id, l.line_id, l.product_id, l.qty FROM ks_fillup_lines l JOIN ks_fillups f ON f.fillup_id = l.fillup_id WHERE f.at >= $1", [since]),
      this.pool.query("SELECT DISTINCT ON (shop_id, product_id) shop_id, product_id, captured_at, quantity FROM ks_stock_history ORDER BY shop_id, product_id, captured_at DESC"),
      this.pool.query("SELECT DISTINCT ON (shop_id) shop_id, from_at, to_at FROM ks_stock_coverage ORDER BY shop_id, from_at DESC"),
    ]);
    for (const r of fillUps.rows)
      ds.fillUps.set(String(r.fillup_id), {
        fillupId: String(r.fillup_id),
        shopId: String(r.shop_id),
        at: num(r.at),
        type: num(r.type),
        notes: r.notes,
        userName: r.user_name,
        detailed: r.detailed,
        detailFailures: Number(r.detail_failures ?? 0),
        retryAt: num(r.retry_at),
      });
    for (const r of fillUpLines.rows) {
      const id = String(r.fillup_id);
      const list = ds.fillUpLines.get(id) ?? [];
      list.push({ fillupId: id, lineId: String(r.line_id), productId: String(r.product_id), qty: Number(r.qty) });
      ds.fillUpLines.set(id, list);
    }
    for (const r of stockHistory.rows) {
      const shop = String(r.shop_id);
      const m = ds.stockHistory.get(shop) ?? new Map<string, { at: number; qty: number }[]>();
      m.set(String(r.product_id), [{ at: Number(r.captured_at), qty: Number(r.quantity) }]);
      ds.stockHistory.set(shop, m);
    }
    for (const r of coverage.rows) ds.stockCoverage.set(String(r.shop_id), [[Number(r.from_at), Number(r.to_at)]]);
    for (const r of groups.rows) ds.groups.set(Number(r.group_id), { groupId: Number(r.group_id), name: r.name });
    for (const r of shops.rows) ds.shops.set(String(r.shop_id), { shopId: String(r.shop_id), name: r.name, stocksAccounting: r.stocks_accounting });
    for (const r of products.rows)
      ds.products.set(String(r.product_id), {
        productId: String(r.product_id),
        name: r.name,
        barcode: r.barcode,
        vendorCode: r.vendor_code,
        price: num(r.price),
        groupId: num(r.group_id),
      });
    for (const r of sales.rows)
      ds.sales.set(String(r.sale_id), {
        saleId: String(r.sale_id),
        shopId: String(r.shop_id),
        soldAt: Number(r.sold_at),
        total: num(r.total),
        detailed: r.detailed,
        detailFailures: Number(r.detail_failures ?? 0),
        retryAt: num(r.retry_at),
      });
    for (const r of positions.rows) {
      const id = String(r.sale_id);
      const list = ds.positions.get(id) ?? [];
      list.push({ saleId: id, positionId: String(r.position_id), productId: String(r.product_id), qty: Number(r.qty), price: num(r.price) });
      ds.positions.set(id, list);
    }
    for (const r of stock.rows) {
      const shop = String(r.shop_id);
      const m = ds.stock.get(shop) ?? new Map<string, number>();
      m.set(String(r.product_id), Number(r.qty));
      ds.stock.set(shop, m);
      ds.stockAt.set(shop, Math.max(ds.stockAt.get(shop) ?? 0, Number(r.synced_at)));
    }
    ds.state = { ...emptySyncState(), ...((state.rows[0]?.value as Partial<KsSyncState>) ?? {}) };
    ds.touch();
  }

  // ───────── history: read per shop / dish, never all at once ─────────

  history(): HistorySource {
    return {
      kind: "postgres",
      shopHistory: (shopId, from, to) => this.readHistory(shopId, from, to, null),
      productHistory: (shopId, productId, from, to) => this.readHistory(shopId, from, to, productId),
      salesByShopProduct: async (since, to) => {
        await this.ready;
        const r = await this.pool.query(
          "SELECT s.shop_id, p.product_id, SUM(p.qty) AS qty, MAX(s.sold_at) AS last FROM ks_sales s JOIN ks_positions p ON p.sale_id = s.sale_id WHERE s.detailed AND s.sold_at >= $1 AND s.sold_at <= $2 GROUP BY s.shop_id, p.product_id",
          [since, to],
        );
        return r.rows.map((x) => ({ shopId: String(x.shop_id), productId: String(x.product_id), qty: Number(x.qty), last: Number(x.last) }));
      },
    };
  }

  private async readHistory(shopId: string, from: number, to: number, productId: string | null): Promise<ShopHistory> {
    await this.ready;
    const [rs, fs_] = await Promise.all([
      this.pool.query(
        `SELECT s.sale_id, s.sold_at, s.detailed, s.total, p.product_id, p.qty FROM ks_sales s LEFT JOIN ks_positions p ON p.sale_id = s.sale_id
         WHERE s.shop_id = $1 AND s.sold_at >= $2 AND s.sold_at < $3 ${productId ? "AND (p.product_id = $4 OR p.product_id IS NULL)" : ""} ORDER BY s.sold_at, s.sale_id`,
        productId ? [shopId, from, to, productId] : [shopId, from, to],
      ),
      this.pool.query(
        `SELECT f.at, f.type, l.product_id, l.qty FROM ks_fillups f JOIN ks_fillup_lines l ON l.fillup_id = f.fillup_id
         WHERE f.shop_id = $1 AND f.at >= $2 AND f.at < $3 AND f.detailed ${productId ? "AND l.product_id = $4" : ""} ORDER BY f.at`,
        productId ? [shopId, from, to, productId] : [shopId, from, to],
      ),
    ]);
    const out: ShopHistory = { sales: [], receipts: [], fills: [] };
    let cur: { saleId: string; at: number; detailed: boolean; total: number | null; lines: string[] } | null = null;
    const flush = () => {
      if (cur) out.receipts.push({ saleId: cur.saleId, at: cur.at, detailed: cur.detailed, total: cur.total, lines: cur.detailed ? cur.lines.sort().join(",") : null });
    };
    for (const r of rs.rows) {
      const id = String(r.sale_id);
      if (!cur || cur.saleId !== id) {
        flush();
        cur = { saleId: id, at: Number(r.sold_at), detailed: r.detailed, total: num(r.total), lines: [] };
      }
      if (r.product_id !== null && r.detailed) {
        cur.lines.push(`${r.product_id}x${Number(r.qty)}`);
        out.sales.push({ saleId: id, at: Number(r.sold_at), productId: String(r.product_id), qty: Number(r.qty) });
      }
    }
    flush();
    for (const r of fs_.rows) out.fills.push({ at: Number(r.at), type: num(r.type), productId: String(r.product_id), qty: Number(r.qty) });
    return out;
  }

  async undetailedSales(_ds: KsDataset, limit: number, now: number): Promise<KsSale[]> {
    await this.ready;
    const r = await this.pool.query(
      "SELECT sale_id, shop_id, sold_at, total, detail_failures, retry_at FROM ks_sales WHERE NOT detailed AND COALESCE(retry_at, 0) <= $1 ORDER BY sold_at DESC LIMIT $2",
      [now, limit],
    );
    return r.rows.map((x) => ({ saleId: String(x.sale_id), shopId: String(x.shop_id), soldAt: Number(x.sold_at), total: num(x.total), detailed: false, detailFailures: Number(x.detail_failures ?? 0), retryAt: num(x.retry_at) }));
  }

  async undetailedFillUps(_ds: KsDataset, limit: number, now: number): Promise<KsFillUp[]> {
    await this.ready;
    const r = await this.pool.query(
      "SELECT fillup_id, shop_id, at, type, notes, user_name, detail_failures, retry_at FROM ks_fillups WHERE NOT detailed AND COALESCE(retry_at, 0) <= $1 ORDER BY at DESC NULLS LAST LIMIT $2",
      [now, limit],
    );
    return r.rows.map((x) => ({ fillupId: String(x.fillup_id), shopId: String(x.shop_id), at: num(x.at), type: num(x.type), notes: x.notes, userName: x.user_name, detailed: false, detailFailures: Number(x.detail_failures ?? 0), retryAt: num(x.retry_at) }));
  }

  async stats(_ds: KsDataset, settleBefore: number): Promise<RepoStats> {
    await this.ready;
    const [s, p, f, st] = await Promise.all([
      this.pool.query(
        `SELECT count(*) AS n, count(*) FILTER (WHERE detailed) AS d, count(*) FILTER (WHERE NOT detailed AND detail_failures > 0) AS r,
                min(sold_at) AS oldest, max(sold_at) AS newest, max(sold_at) FILTER (WHERE NOT detailed AND sold_at < $1) AS nu FROM ks_sales`,
        [settleBefore],
      ),
      this.pool.query("SELECT count(*) AS n, COALESCE(sum(qty), 0) AS u FROM ks_positions"),
      this.pool.query("SELECT count(*) AS n, count(*) FILTER (WHERE NOT detailed) AS nd, max(at) FILTER (WHERE NOT detailed AND at < $1) AS nu FROM ks_fillups", [settleBefore]),
      this.pool.query("SELECT count(*) AS n FROM ks_stock"),
    ]);
    const n = (v: unknown) => Number(v ?? 0);
    const receipts = n(s.rows[0].n);
    const positions = n(p.rows[0].n);
    return {
      receipts,
      receiptsDetailed: n(s.rows[0].d),
      receiptsUndetailed: receipts - n(s.rows[0].d),
      receiptsRetrying: n(s.rows[0].r),
      positions,
      units: Math.round(n(p.rows[0].u)),
      fillUps: n(f.rows[0].n),
      fillUpsUndetailed: n(f.rows[0].nd),
      stockRows: n(st.rows[0].n),
      oldestSale: num(s.rows[0].oldest),
      newestSale: num(s.rows[0].newest),
      newestUndetailedSale: num(s.rows[0].nu),
      newestUndetailedFillUp: num(f.rows[0].nu),
      historyRowsInDb: receipts + positions + n(f.rows[0].n),
    };
  }

  // ───────── the nightly analytics result ─────────

  async saveShopAnalytics(sa: ShopAnalytics, day: number) {
    await this.ready;
    const iso = (d: number) => new Date(d * 86_400_000).toISOString().slice(0, 10);
    const daily: unknown[][] = [];
    for (const [pid, rows] of sa.dailyRows)
      for (const r of rows)
        daily.push([iso(r.day), sa.shopId, pid, r.delivered, r.sold, r.removed, r.writtenOff, r.closingStock, r.delivered > 0 ? Math.round((r.sold / r.delivered) * 1000) / 1000 : null, r.hadStock, r.quality]);
    await this.pool.query("DELETE FROM product_shop_daily WHERE shop_id = $1", [sa.shopId]);
    if (daily.length)
      await this.upsert("product_shop_daily", ["date", "shop_id", "product_id", "delivered_qty", "sold_qty", "removed_qty", "writeoff_qty", "closing_stock", "sell_through", "had_stock", "data_quality"], daily,
        "shop_id, product_id, date", "NOTHING");
    const stats: unknown[][] = [];
    for (const [pid, st] of sa.stats) {
      const done = st.recent.filter((b) => b.complete);
      const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(xs.length / 2) - 1] : null);
      const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
      const L = st.batches.loaded;
      const confidence = st.incomplete.length === 0 && st.recentComplete >= 6 ? "HIGH" : st.recentComplete >= 3 ? "MEDIUM" : "LOW";
      stats.push([
        sa.shopId, pid, st.sold.d7, st.sold.d14, st.sold.d30, st.sold.d60, st.sold.d180,
        st.batches.count, avg(done.map((b) => b.loaded)), med(done.map((b) => b.loaded)), avg(done.map((b) => b.soldInShelf)), med(done.map((b) => b.soldInShelf)),
        L ? Math.round((st.batches.writtenOff / L) * 1000) / 1000 : null, L ? Math.round((st.batches.unloaded / L) * 1000) / 1000 : null,
        st.batches.sellThrough === null ? null : Math.round(st.batches.sellThrough * 1000) / 1000,
        st.norm?.min ?? null, st.norm?.rec ?? null, st.norm?.max ?? null, confidence, st.status, JSON.stringify(st), Date.now(),
      ]);
    }
    await this.pool.query("DELETE FROM product_shop_stats WHERE shop_id = $1", [sa.shopId]);
    if (stats.length)
      await this.upsert("product_shop_stats", ["shop_id", "product_id", "sales_7d", "sales_14d", "sales_30d", "sales_60d", "sales_180d", "deliveries_count", "avg_delivery_qty", "median_delivery_qty",
        "avg_sold_per_delivery", "median_sold_per_delivery", "writeoff_rate", "removal_rate", "sell_through_rate", "recommended_min", "recommended_qty", "recommended_max", "confidence", "status", "detail", "updated_at"],
        stats, "shop_id, product_id", "NOTHING");
    void day;
  }

  async saveAnalytics(c: AnalyticsCache) {
    await this.ready;
    await this.pool.query("INSERT INTO analytics_cache (id, run_at, data) VALUES (1, $1, $2) ON CONFLICT (id) DO UPDATE SET run_at = EXCLUDED.run_at, data = EXCLUDED.data, updated_at = now()", [c.runAt, serializeCache(c)]);
  }

  async loadAnalytics(): Promise<AnalyticsCache | null> {
    await this.ready;
    const r = await this.pool.query("SELECT data FROM analytics_cache WHERE id = 1");
    return r.rows[0] ? deserializeCache(r.rows[0].data) : null;
  }

  // ───────── Завтра ─────────

  async getMenu(date: string): Promise<MenuRow[]> {
    await this.ready;
    const r = await this.pool.query("SELECT product_id, source, added_by, added_at FROM tomorrow_menu WHERE date = $1 ORDER BY added_at", [date]);
    return r.rows.map((x) => ({ productId: String(x.product_id), source: x.source, addedBy: x.added_by, addedAt: Number(x.added_at) }));
  }

  async setMenu(date: string, add: { productId: string; source: string }[], remove: string[], by: string) {
    await this.ready;
    if (remove.length) await this.pool.query("DELETE FROM tomorrow_menu WHERE date = $1 AND product_id = ANY($2::bigint[])", [date, remove]);
    if (add.length) await this.upsert("tomorrow_menu", ["date", "product_id", "source", "added_by", "added_at"], add.map((a) => [date, a.productId, a.source, by, Date.now()]), "date, product_id", "NOTHING");
  }

  async getPlan(date: string): Promise<PlanRow[]> {
    await this.ready;
    const r = await this.pool.query("SELECT * FROM tomorrow_plan WHERE date = $1", [date]);
    return r.rows.map((x) => ({
      shopId: String(x.shop_id),
      productId: String(x.product_id),
      recommendedQty: num(x.recommended_qty),
      recMin: num(x.rec_min),
      recMax: num(x.rec_max),
      expectedLeft: Number(x.expected_left),
      confidence: x.confidence,
      reason: x.reason,
      manualQty: num(x.manual_qty),
      manualBy: x.manual_by,
      manualAt: num(x.manual_at),
      updatedAt: Number(x.updated_at),
    }));
  }

  async upsertRecommendations(date: string, rows: Omit<PlanRow, "manualQty" | "manualBy" | "manualAt">[]) {
    if (!rows.length) return;
    await this.upsert("tomorrow_plan", ["date", "shop_id", "product_id", "recommended_qty", "rec_min", "rec_max", "expected_left", "confidence", "reason", "updated_at"],
      rows.map((r) => [date, r.shopId, r.productId, r.recommendedQty, r.recMin, r.recMax, r.expectedLeft, r.confidence, JSON.stringify(r.reason ?? null), r.updatedAt]),
      "date, shop_id, product_id",
      "UPDATE SET recommended_qty = EXCLUDED.recommended_qty, rec_min = EXCLUDED.rec_min, rec_max = EXCLUDED.rec_max, expected_left = EXCLUDED.expected_left, confidence = EXCLUDED.confidence, reason = EXCLUDED.reason, updated_at = EXCLUDED.updated_at");
  }

  async setManual(date: string, shopId: string, productId: string, qty: number | null, by: string) {
    await this.ready;
    await this.pool.query(
      `INSERT INTO tomorrow_plan (date, shop_id, product_id, expected_left, confidence, manual_qty, manual_by, manual_at, updated_at) VALUES ($1, $2, $3, 0, 'LOW', $4, $5, $6, $6)
       ON CONFLICT (date, shop_id, product_id) DO UPDATE SET manual_qty = EXCLUDED.manual_qty, manual_by = EXCLUDED.manual_by, manual_at = EXCLUDED.manual_at`,
      [date, shopId, productId, qty, qty === null ? null : by, qty === null ? null : Date.now()],
    );
  }

  /** Multi-row upsert in chunks (keeps each statement small). */
  private async upsert(table: string, cols: string[], rows: unknown[][], conflict: string, update: string) {
    await this.ready;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const values = chunk.map((r, j) => `(${r.map((_, k) => `$${j * cols.length + k + 1}`).join(",")})`).join(",");
      await this.pool.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${values} ON CONFLICT (${conflict}) DO ${update}`, chunk.flat() as unknown[]);
    }
  }

  async saveShops(shops: KsShop[]) {
    await this.upsert("ks_shops", ["shop_id", "name", "stocks_accounting"], shops.map((s) => [s.shopId, s.name, s.stocksAccounting]), "shop_id",
      "UPDATE SET name = EXCLUDED.name, stocks_accounting = EXCLUDED.stocks_accounting, updated_at = now()");
  }

  async saveProducts(products: KsProduct[]) {
    await this.upsert("ks_products", ["product_id", "name", "barcode", "vendor_code", "price", "group_id"],
      products.map((p) => [p.productId, p.name, p.barcode, p.vendorCode, p.price, p.groupId]), "product_id",
      "UPDATE SET name = EXCLUDED.name, barcode = EXCLUDED.barcode, vendor_code = EXCLUDED.vendor_code, price = EXCLUDED.price, group_id = EXCLUDED.group_id, updated_at = now()");
  }

  async saveGroups(groups: KsGroup[]) {
    await this.upsert("ks_groups", ["group_id", "name"], groups.map((g) => [g.groupId, g.name]), "group_id", "UPDATE SET name = EXCLUDED.name, updated_at = now()");
  }

  async replaceStock(shopId: string, rows: KsStock[], at: number) {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM ks_stock WHERE shop_id = $1", [shopId]);
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const values = chunk.map((_, j) => `($${j * 4 + 1},$${j * 4 + 2},$${j * 4 + 3},$${j * 4 + 4})`).join(",");
        await client.query(`INSERT INTO ks_stock (shop_id, product_id, qty, synced_at) VALUES ${values}`, chunk.flatMap((r) => [shopId, r.productId, r.qty, at]));
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async saveSales(sales: KsSale[]) {
    // never reset `detailed` of an already detailed receipt
    await this.upsert("ks_sales", ["sale_id", "shop_id", "sold_at", "total", "detailed"], sales.map((s) => [s.saleId, s.shopId, s.soldAt, s.total, s.detailed]), "sale_id",
      "UPDATE SET shop_id = EXCLUDED.shop_id, sold_at = EXCLUDED.sold_at, total = EXCLUDED.total, detailed = ks_sales.detailed OR EXCLUDED.detailed");
  }

  async savePositions(saleId: string, positions: KsPosition[]) {
    if (positions.length)
      await this.upsert("ks_positions", ["sale_id", "position_id", "product_id", "qty", "price"],
        positions.map((p) => [p.saleId, p.positionId, p.productId, p.qty, p.price]), "sale_id, position_id",
        "UPDATE SET product_id = EXCLUDED.product_id, qty = EXCLUDED.qty, price = EXCLUDED.price");
    await this.pool.query("UPDATE ks_sales SET detailed = true, retry_at = NULL WHERE sale_id = $1", [saleId]);
  }

  async markDetailFailed(saleId: string, failures: number, retryAt: number) {
    await this.ready;
    await this.pool.query("UPDATE ks_sales SET detail_failures = $2, retry_at = $3 WHERE sale_id = $1", [saleId, failures, retryAt]);
  }

  async saveFillUps(rows: KsFillUp[]) {
    await this.upsert("ks_fillups", ["fillup_id", "shop_id", "at", "type", "notes", "user_name", "detailed"],
      rows.map((f) => [f.fillupId, f.shopId, f.at, f.type, f.notes, f.userName, f.detailed]), "fillup_id",
      "UPDATE SET shop_id = EXCLUDED.shop_id, at = EXCLUDED.at, type = EXCLUDED.type, notes = EXCLUDED.notes, user_name = EXCLUDED.user_name, detailed = ks_fillups.detailed OR EXCLUDED.detailed");
  }

  async saveFillUpLines(fillupId: string, lines: KsFillUpLine[]) {
    if (lines.length)
      await this.upsert("ks_fillup_lines", ["fillup_id", "line_id", "product_id", "qty"], lines.map((l) => [l.fillupId, l.lineId, l.productId, l.qty]), "fillup_id, line_id",
        "UPDATE SET product_id = EXCLUDED.product_id, qty = EXCLUDED.qty");
    await this.ready;
    await this.pool.query("UPDATE ks_fillups SET detailed = true, retry_at = NULL WHERE fillup_id = $1", [fillupId]);
  }

  async markFillUpFailed(fillupId: string, failures: number, retryAt: number) {
    await this.ready;
    await this.pool.query("UPDATE ks_fillups SET detail_failures = $2, retry_at = $3 WHERE fillup_id = $1", [fillupId, failures, retryAt]);
  }

  async saveStockChanges(shopId: string, changes: { productId: string; qty: number }[], at: number, coverage: [number, number]) {
    if (changes.length)
      await this.upsert("ks_stock_history", ["shop_id", "product_id", "captured_at", "quantity"], changes.map((c) => [shopId, c.productId, at, c.qty]),
        "shop_id, product_id, captured_at", "UPDATE SET quantity = EXCLUDED.quantity");
    await this.upsert("ks_stock_coverage", ["shop_id", "from_at", "to_at"], [[shopId, coverage[0], coverage[1]]], "shop_id, from_at", "UPDATE SET to_at = EXCLUDED.to_at");
  }

  async saveState(state: KsSyncState) {
    await this.ready;
    await this.pool.query(
      "INSERT INTO ks_sync_state (key, value) VALUES ('sync', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
      [JSON.stringify(state)],
    );
  }
}

// ───────────────────────── file (local development) ─────────────────────────

export class FileKsRepo extends InMemoryOps implements KsRepo {
  readonly kind = "file" as const;
  private file: string;
  private ds: KsDataset | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(dir = path.join(process.cwd(), process.env.FILE_STORE_DIR || ".data")) {
    super();
    this.file = path.join(dir, "kitshop.json");
    this.extra = path.join(dir, "kitshop-analytics.json");
    try {
      const raw = JSON.parse(fs.readFileSync(this.extra, "utf8"));
      this.analytics = raw.analytics ? deserializeCache(raw.analytics) : null;
      this.menus = new Map(Object.entries(raw.menus ?? {}));
      this.plans = new Map(Object.entries(raw.plans ?? {}).map(([d, rows]) => [d, new Map((rows as PlanRow[]).map((r) => [`${r.shopId}|${r.productId}`, r]))]));
    } catch {
      /* first start */
    }
  }

  private extra: string;

  protected persist() {
    fs.mkdirSync(path.dirname(this.extra), { recursive: true });
    const data = {
      analytics: this.analytics ? serializeCache(this.analytics) : null,
      menus: Object.fromEntries(this.menus),
      plans: Object.fromEntries([...this.plans].map(([d, m]) => [d, [...m.values()]])),
    };
    fs.writeFileSync(`${this.extra}.tmp`, JSON.stringify(data));
    fs.renameSync(`${this.extra}.tmp`, this.extra);
  }

  async load(ds: KsDataset) {
    this.ds = ds;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const s of raw.shops ?? []) ds.shops.set(s.shopId, s);
      for (const p of raw.products ?? []) ds.products.set(p.productId, p);
      for (const g of raw.groups ?? []) ds.groups.set(g.groupId, g);
      for (const s of raw.sales ?? []) ds.sales.set(s.saleId, s);
      for (const p of raw.positions ?? []) ds.positions.set(p.saleId, [...(ds.positions.get(p.saleId) ?? []), p]);
      for (const r of raw.stock ?? []) {
        const m = ds.stock.get(r.shopId) ?? new Map<string, number>();
        m.set(r.productId, r.qty);
        ds.stock.set(r.shopId, m);
      }
      for (const [k, v] of Object.entries(raw.stockAt ?? {})) ds.stockAt.set(k, Number(v));
      for (const f of raw.fillUps ?? []) ds.fillUps.set(f.fillupId, f);
      for (const l of raw.fillUpLines ?? []) ds.fillUpLines.set(l.fillupId, [...(ds.fillUpLines.get(l.fillupId) ?? []), l]);
      for (const r of raw.stockHistory ?? []) {
        const m = ds.stockHistory.get(r.shopId) ?? new Map<string, { at: number; qty: number }[]>();
        m.set(r.productId, [...(m.get(r.productId) ?? []), { at: r.at, qty: r.qty }]);
        ds.stockHistory.set(r.shopId, m);
      }
      for (const [k, v] of Object.entries(raw.stockCoverage ?? {})) ds.stockCoverage.set(k, v as [number, number][]);
      ds.state = { ...emptySyncState(), ...(raw.state ?? {}) };
      ds.touch();
    } catch {
      /* first start */
    }
  }

  private schedule() {
    if (this.timer || !this.ds) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const ds = this.ds!;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const data = {
        shops: [...ds.shops.values()],
        products: [...ds.products.values()],
        groups: [...ds.groups.values()],
        sales: [...ds.sales.values()],
        positions: [...ds.positions.values()].flat(),
        stock: [...ds.stock.entries()].flatMap(([shopId, m]) => [...m.entries()].map(([productId, qty]) => ({ shopId, productId, qty }))),
        stockAt: Object.fromEntries(ds.stockAt),
        fillUps: [...ds.fillUps.values()],
        fillUpLines: [...ds.fillUpLines.values()].flat(),
        stockHistory: [...ds.stockHistory.entries()].flatMap(([shopId, m]) =>
          [...m.entries()].flatMap(([productId, list]) => list.map((x) => ({ shopId, productId, at: x.at, qty: x.qty })))),
        stockCoverage: Object.fromEntries(ds.stockCoverage),
        state: ds.state,
      };
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(data));
      fs.renameSync(`${this.file}.tmp`, this.file);
    }, 2000);
  }

  async saveShops() {
    this.schedule();
  }
  async saveProducts() {
    this.schedule();
  }
  async saveGroups() {
    this.schedule();
  }
  async markDetailFailed() {
    this.schedule();
  }
  async replaceStock() {
    this.schedule();
  }
  async saveSales() {
    this.schedule();
  }
  async savePositions() {
    this.schedule();
  }
  async saveState() {
    this.schedule();
  }
  async saveFillUps() {
    this.schedule();
  }
  async saveFillUpLines() {
    this.schedule();
  }
  async markFillUpFailed() {
    this.schedule();
  }
  async saveStockChanges() {
    this.schedule();
  }
}
