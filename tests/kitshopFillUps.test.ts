import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { KsDataset } from "../src/lib/kitshop-data/dataset";
import { PgKsRepo } from "../src/lib/kitshop-data/repo";
import { KitShopSync } from "../src/lib/kitshop-data/sync";

/**
 * The sync keeps what product analytics needs and KiT Shop only gives "now":
 *  • stock history — every GetShopStocks reading as a change log + the periods it covers (persisted in ks_stock_history);
 *  • loads / unloads of our fridges (GetFillUps + GetFillUpById), 180-day backfill, persisted.
 * Only get* methods exist on the fake KiT Shop; anything else throws.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const SHOP = "621583";
const OTHER = "999999"; // not ours
const pad = (n: number) => String(n).padStart(2, "0");
const ks = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

function poolOf(db: PGlite): Pool {
  const query = async (text: string, params?: unknown[]) => {
    if (!params?.length && text.split(";").filter((x) => x.trim()).length > 1) {
      await db.exec(text);
      return { rows: [], rowCount: 0 };
    }
    const r = await db.query<Record<string, unknown>>(text, params as unknown[]);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  return { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
}

function fake() {
  const stock = new Map<string, number>([["101", 5], ["102", 2]]);
  const fillUps = [
    // in the list without lines → GetFillUpById
    { FillupId: "1", ShopId: SHOP, FillupType: 1, FillupDateTime: ks(NOW - 2 * DAY), Notes: null, UserName: "Айгерим" },
    // lines already in the list
    { FillupId: "2", ShopId: SHOP, FillupType: 2, FillupDateTime: ks(NOW - 1 * DAY), Notes: "Списание: истёк срок", UserName: "Айгерим", Details: [{ DetailId: 21, ProductId: "102", Quantity: -2 }] },
    { FillupId: "3", ShopId: OTHER, FillupType: 1, FillupDateTime: ks(NOW - DAY), Notes: null, UserName: "x" },
    // old: reached only by the backfill
    { FillupId: "4", ShopId: SHOP, FillupType: 1, FillupDateTime: ks(NOW - 4 * DAY), Notes: null, UserName: "y" },
  ];
  const log = { list: [] as { from: number; to: number }[], byId: [] as string[] };
  const impl = {
    async getShops() {
      return [{ ShopId: SHOP, ShopName: "SATTI 1", StocksAccounting: true }];
    },
    async getProducts() {
      return [
        { ProductId: "101", ProductName: "Паста", Price: 2000 },
        { ProductId: "102", ProductName: "Цезарь", Price: 1900 },
      ];
    },
    async getShopStocks() {
      return [...stock].map(([ProductId, Quantity]) => ({ ProductId, Quantity }));
    },
    async getSales() {
      return [];
    },
    async getSaleById() {
      return null;
    },
    async getFillUps(q: { from: number; to: number }) {
      log.list.push(q);
      const t = (s: string) => Date.UTC(+s.slice(6, 10), +s.slice(3, 5) - 1, +s.slice(0, 2), +s.slice(11, 13), +s.slice(14, 16));
      return fillUps.filter((f) => t(f.FillupDateTime) >= q.from && t(f.FillupDateTime) <= q.to);
    },
    async getFillUpById(id: string) {
      log.byId.push(id);
      const f = fillUps.find((x) => x.FillupId === id)!;
      return { ...f, Details: [{ DetailId: Number(id) * 10, ProductId: "101", Quantity: 6 }] };
    },
  };
  const reader = new Proxy(impl, {
    get(t, prop: string) {
      if (!prop.startsWith("get")) throw new Error(`write-like access: ${prop}`);
      return (t as Record<string, unknown>)[prop];
    },
  });
  return { reader: reader as never, stock, log };
}

test("loads / unloads: our fridges only, lines from the list or GetFillUpById, backfill to the history depth, persisted", async () => {
  const pool = poolOf(new PGlite());
  const k = fake();
  const ds = new KsDataset();
  const now = NOW;
  const sync = new KitShopSync({ reader: k.reader, repo: new PgKsRepo(pool), ds, now: () => now, ourShopIds: [SHOP], options: { backfillDays: 5, delayMs: 0 } });
  await sync.tick();
  await sync.tick();
  assert.deepEqual([...ds.fillUps.keys()].sort(), ["1", "2", "4"], "the fill-up of another company shop is ignored");
  assert.deepEqual(ds.fillUpLines.get("2"), [{ fillupId: "2", lineId: "21", productId: "102", qty: -2 }], "lines given in the list are kept as they are");
  assert.ok(!k.log.byId.includes("2"), "no GetFillUpById when the list already had the lines");
  assert.ok(k.log.byId.includes("1") && k.log.byId.includes("4"));
  assert.ok(ds.state.fillupsBackfillFrom! <= NOW - 5 * DAY, "backfill reached the history depth");
  assert.ok(k.log.list.every((q) => q.to - q.from <= 60 * DAY), "never more than 60 days per GetFillUps");

  // restart: everything comes back from Postgres, nothing is detailed again
  const ds2 = new KsDataset();
  await new PgKsRepo(pool).load(ds2);
  assert.equal(ds2.fillUps.size, 3);
  assert.equal(ds2.fillUps.get("2")!.notes, "Списание: истёк срок");
  assert.ok([...ds2.fillUps.values()].every((f) => f.detailed));
  assert.equal(ds2.fillUpLines.get("1")![0].qty, 6);
});

test("stock history: every reading kept as a change log with its coverage; a gap opens a new period with the full state", async () => {
  const pool = poolOf(new PGlite());
  const k = fake();
  const ds = new KsDataset();
  let now = NOW;
  const sync = new KitShopSync({ reader: k.reader, repo: new PgKsRepo(pool), ds, now: () => now, ourShopIds: [SHOP], options: { backfillDays: 1, delayMs: 0 } });
  await sync.tick(); // full state: 101=5, 102=2
  now += 5 * 60_000;
  k.stock.set("101", 4);
  await sync.tick(); // only 101 changed
  now += 5 * 60_000;
  k.stock.delete("102");
  await sync.tick(); // 102 sold out → 0
  now += 5 * 60_000;
  await sync.tick(); // nothing changed → no rows, coverage extended
  now += 2 * 3_600_000; // the sync was down for 2 hours
  await sync.tick(); // new period: full state again

  const h = ds.stockHistory.get(SHOP)!;
  assert.deepEqual(h.get("101")!.map((x) => x.qty), [5, 4, 4]);
  assert.deepEqual(h.get("102")!.map((x) => x.qty), [2, 0]);
  assert.deepEqual(ds.stockCoverage.get(SHOP), [
    [NOW, NOW + 15 * 60_000],
    [NOW + 15 * 60_000 + 2 * 3_600_000, NOW + 15 * 60_000 + 2 * 3_600_000],
  ]);
  const rows = await pool.query("SELECT shop_id, product_id, captured_at, quantity FROM ks_stock_history ORDER BY captured_at, product_id");
  assert.equal(rows.rows.length, 5, "5 rows instead of 5 readings × 2 dishes");

  const ds2 = new KsDataset();
  await new PgKsRepo(pool).load(ds2);
  assert.deepEqual(ds2.stockHistory.get(SHOP)!.get("101")!.map((x) => x.qty), [5, 4, 4]);
  assert.deepEqual(ds2.stockCoverage.get(SHOP), ds.stockCoverage.get(SHOP));
});
