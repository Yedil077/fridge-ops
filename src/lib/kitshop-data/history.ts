import type { KsDataset } from "./dataset";

/**
 * Where the HISTORY of KiT Shop data is read from — never kept in memory in production:
 *  • PostgreSQL (PgKsRepo): SELECT only the shop / dish asked for;
 *  • the in-memory dataset (dev file store, tests): the same answers from the maps.
 * The nightly analytics job and the detailed screens read history only through this interface.
 */

export interface ShopHistory {
  /** product lines of receipts WITH lines (GetSaleById done), ascending time */
  sales: { saleId: string; at: number; productId: string; qty: number }[];
  /** every receipt (with or without lines), ascending time — continuity, duplicates */
  receipts: { saleId: string; at: number; detailed: boolean; total: number | null; lines: string | null }[];
  /** lines of loads / unloads / write-offs with a known time, ascending: type 1 load, 2 unload, 3 write-off */
  fills: { at: number; type: number | null; productId: string; qty: number }[];
}

export interface HistorySource {
  readonly kind: "postgres" | "memory";
  shopHistory(shopId: string, from: number, to: number): Promise<ShopHistory>;
  /** one dish in one shop (the dish card: all its deliveries) */
  productHistory(shopId: string, productId: string, from: number, to: number): Promise<ShopHistory>;
  /** units sold per shop × dish since `since` and the last sale (the "что удалить" report) */
  salesByShopProduct(since: number, to: number): Promise<{ shopId: string; productId: string; qty: number; last: number }[]>;
}

/** History answered from an in-memory dataset (development file store, tests). */
export function dsHistory(ds: KsDataset): HistorySource & { shopHistorySync(shopId: string, from: number, to: number, productId?: string): ShopHistory } {
  const shopHistorySync = (shopId: string, from: number, to: number, productId?: string): ShopHistory => {
    const out: ShopHistory = { sales: [], receipts: [], fills: [] };
    for (const s of ds.sales.values()) {
      if (s.shopId !== shopId || s.soldAt < from || s.soldAt >= to) continue;
      const lines = ds.positions.get(s.saleId) ?? [];
      out.receipts.push({
        saleId: s.saleId,
        at: s.soldAt,
        detailed: s.detailed,
        total: s.total,
        lines: s.detailed ? lines.map((l) => `${l.productId}x${l.qty}`).sort().join(",") : null,
      });
      if (!s.detailed) continue;
      for (const l of lines) if (!productId || l.productId === productId) out.sales.push({ saleId: s.saleId, at: s.soldAt, productId: l.productId, qty: l.qty });
    }
    for (const f of ds.fillUps.values()) {
      if (f.shopId !== shopId || f.at === null || f.at < from || f.at >= to || !f.detailed) continue;
      for (const l of ds.fillUpLines.get(f.fillupId) ?? []) if (!productId || l.productId === productId) out.fills.push({ at: f.at, type: f.type, productId: l.productId, qty: l.qty });
    }
    out.sales.sort((a, b) => a.at - b.at);
    out.receipts.sort((a, b) => a.at - b.at);
    out.fills.sort((a, b) => a.at - b.at);
    return out;
  };
  return {
    kind: "memory",
    shopHistorySync,
    shopHistory: async (shopId, from, to) => shopHistorySync(shopId, from, to),
    productHistory: async (shopId, productId, from, to) => shopHistorySync(shopId, from, to, productId),
    salesByShopProduct: async (since, to) => {
      const m = new Map<string, { shopId: string; productId: string; qty: number; last: number }>();
      for (const s of ds.sales.values()) {
        if (!s.detailed || s.soldAt < since || s.soldAt > to) continue;
        for (const l of ds.positions.get(s.saleId) ?? []) {
          const k = `${s.shopId}|${l.productId}`;
          const cur = m.get(k) ?? { shopId: s.shopId, productId: l.productId, qty: 0, last: 0 };
          cur.qty += l.qty;
          cur.last = Math.max(cur.last, s.soldAt);
          m.set(k, cur);
        }
      }
      return [...m.values()];
    },
  };
}
