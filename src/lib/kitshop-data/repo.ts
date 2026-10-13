import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { KsDataset, emptySyncState, type KsGroup, type KsPosition, type KsProduct, type KsSale, type KsShop, type KsStock, type KsSyncState } from "./dataset";

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
}

export class MemoryKsRepo implements KsRepo {
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
CREATE TABLE IF NOT EXISTS ks_sync_state (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
`;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export class PgKsRepo implements KsRepo {
  readonly kind = "postgres" as const;
  private ready: Promise<void>;

  constructor(private pool: Pool) {
    this.ready = pool.query(DDL).then(() => undefined);
  }

  async load(ds: KsDataset) {
    await this.ready;
    const [shops, products, sales, positions, stock, state, groups] = await Promise.all([
      this.pool.query("SELECT shop_id, name, stocks_accounting FROM ks_shops"),
      this.pool.query("SELECT product_id, name, barcode, vendor_code, price, group_id FROM ks_products"),
      this.pool.query("SELECT sale_id, shop_id, sold_at, total, detailed, detail_failures, retry_at FROM ks_sales"),
      this.pool.query("SELECT sale_id, position_id, product_id, qty, price FROM ks_positions"),
      this.pool.query("SELECT shop_id, product_id, qty, synced_at FROM ks_stock"),
      this.pool.query("SELECT value FROM ks_sync_state WHERE key = 'sync'"),
      this.pool.query("SELECT group_id, name FROM ks_groups"),
    ]);
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

  /** Multi-row upsert in chunks (keeps each statement small). */
  private async upsert(table: string, cols: string[], rows: unknown[][], conflict: string, update: string) {
    await this.ready;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const values = chunk.map((r, j) => `(${r.map((_, k) => `$${j * cols.length + k + 1}`).join(",")})`).join(",");
      await this.pool.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${values} ON CONFLICT (${conflict}) DO ${update}`, chunk.flat());
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

  async saveState(state: KsSyncState) {
    await this.ready;
    await this.pool.query(
      "INSERT INTO ks_sync_state (key, value) VALUES ('sync', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
      [JSON.stringify(state)],
    );
  }
}

// ───────────────────────── file (local development) ─────────────────────────

export class FileKsRepo implements KsRepo {
  readonly kind = "file" as const;
  private file: string;
  private ds: KsDataset | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(dir = path.join(process.cwd(), process.env.FILE_STORE_DIR || ".data")) {
    this.file = path.join(dir, "kitshop.json");
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
}
