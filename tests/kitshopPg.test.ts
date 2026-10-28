import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { PgKsRepo } from "../src/lib/kitshop-data/repo";
import { syncOptionsFromEnv } from "../src/lib/kitshop-data/sync";
import { KitShopLive } from "../src/lib/server/kitshopLive";

/**
 * Real PostgreSQL (PGlite, in-process) behind the production PgKsRepo: cold start, restart, duplicate protection,
 * GetSaleById failures, load limits. The fake KiT Shop below only has get* methods.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 13, 14, 0, 0);
const SHOPS = ["621136", "621583"];
const pad = (n: number) => String(n).padStart(2, "0");
const ks = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

/** pg.Pool-compatible wrapper over PGlite (one connection; multi-statement DDL goes through exec). */
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

/** 10 days of receipts, 6 per shop per day; ids 1… */
function makeSales(days = 10) {
  const out: { id: string; shop: string; at: number; pid: string }[] = [];
  let id = 0;
  for (let d = days; d >= 0; d--)
    for (const shop of SHOPS)
      for (let k = 0; k < 6; k++) {
        const at = NOW - d * DAY - (k + 1) * 3_600_000;
        out.push({ id: String(++id), shop, at, pid: k % 2 ? "101" : "102" });
      }
  return out;
}

function fakeKitShop(sales: ReturnType<typeof makeSales>, opts: { failIds?: Set<string>; latencyMs?: number } = {}) {
  const log = { getSales: [] as { from: number; to: number }[], getSaleById: [] as string[], inFlight: 0, maxInFlight: 0, other: [] as string[] };
  const wait = () => new Promise((r) => setTimeout(r, opts.latencyMs ?? 0));
  const reader = {
    async getShops() {
      log.other.push("GetShops");
      return SHOPS.map((s) => ({ ShopId: s, ShopName: `Shop ${s}`, StocksAccounting: true }));
    },
    async getProducts() {
      return [
        { ProductId: "101", ProductName: "Праздничный плов", Price: 2000, GroupId: 7 },
        { ProductId: "102", ProductName: "Микс здоровья", Price: 900, GroupId: 8 },
      ];
    },
    async getProductGroups() {
      return [
        { GroupId: 7, GroupName: "Горячие блюда" },
        { GroupId: 8, GroupName: "Салаты" },
      ];
    },
    async getShopStocks(shopId: string) {
      return [{ ProductId: "101", Quantity: shopId === "621136" ? 5 : 2 }];
    },
    async getSales(q: { from: number; to: number }) {
      log.getSales.push(q);
      return sales.filter((s) => s.at >= q.from && s.at <= q.to).map((s) => ({ SaleId: s.id, ShopId: s.shop, SaleDateTime: ks(s.at), Sum: 1000 }));
    },
    async getSaleById(id: string) {
      log.getSaleById.push(id);
      log.inFlight++;
      log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
      try {
        await wait();
        if (opts.failIds?.has(id)) throw new Error(`KiT Shop ResultCode 1 for sale ${id}`);
        const s = sales.find((x) => x.id === id)!;
        return { SaleId: s.id, ShopId: s.shop, SaleDateTime: ks(s.at), Positions: [{ PositionId: `${id}1`, ProductId: s.pid, Quantity: 1, Price: 1000 }] };
      } finally {
        log.inFlight--;
      }
    },
  };
  return { reader: reader as never, log };
}

const opts = { backfillDays: 5, backfillChunksPerTick: 2, delayMs: 0, detailsPerTick: 1000 };

test("cold start: empty Postgres → 'Данные загружаются' (no simulator); after the first sync → real snapshot", async () => {
  const db = new PGlite();
  const { reader } = fakeKitShop(makeSales());
  const live = new KitShopLive({ repo: new PgKsRepo(poolOf(db)), reader, now: () => NOW, options: opts, autoAnalytics: false });
  await live.ready();
  assert.equal(live.label(), "LOADING");
  await assert.rejects(live.snapshot(), /загружаются/);
  const tick = await live.syncNow();
  assert.ok(tick.ok, JSON.stringify(tick.steps));
  const snap = await live.snapshot();
  assert.equal(snap.source, "kitshop");
  assert.deepEqual(snap.fridges.map((f) => f.externalId).sort(), SHOPS);
  assert.equal(live.label(), "KITSHOP REAL");
  // category from the KiT Shop group, not from the name ("Микс здоровья" means nothing by name)
  assert.equal(snap.products.find((p) => p.externalId === "102")?.categoryId, "salad");
  assert.deepEqual(snap.categorizedBy, { group: 2, name: 0 });
  const t = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ks_stock");
  assert.equal(t.rows[0].n, 2);
  await db.close();
});

test("restart: history is read from ks_* tables, backfill continues where it stopped, nothing is re-downloaded", async () => {
  const db = new PGlite();
  const sales = makeSales();
  const a = fakeKitShop(sales);
  const live1 = new KitShopLive({ repo: new PgKsRepo(poolOf(db)), reader: a.reader, now: () => NOW, options: opts, autoAnalytics: false });
  await live1.ready();
  await live1.syncNow();
  const before = (await live1.status()).progress;
  assert.equal(before.daysDone, 3, "1 day of new sales + 2 backfill chunks");
  const detailedBefore = before.receiptsDetailed;

  // "restart": a new process, same database
  const b = fakeKitShop(sales);
  const live2 = new KitShopLive({ repo: new PgKsRepo(poolOf(db)), reader: b.reader, now: () => NOW + 5 * 60_000, options: opts, autoAnalytics: false });
  await live2.ready();
  const loaded = await live2.status();
  assert.equal(loaded.counts.sales, before.receipts, "receipts come from Postgres");
  assert.equal(loaded.progress.daysDone, 3, "backfill position survived the restart");
  await live2.syncNow();
  // new-sales request starts at the last sync − 2 min overlap, not 180 days back
  assert.equal(b.log.getSales[0].from, NOW - 2 * 60_000);
  // history continues from the persisted backfill point (NOW − 3 days) — never from today again
  const history = b.log.getSales.slice(1);
  assert.ok(history.length > 0 && history.every((q) => q.to <= NOW - 3 * DAY + 1), JSON.stringify(history));
  // receipts already detailed before the restart are not requested again
  const before1 = new Set(a.log.getSaleById);
  assert.ok(b.log.getSaleById.every((id) => !before1.has(id)), "no GetSaleById for already detailed receipts");
  const after = (await live2.status()).progress;
  assert.equal(after.daysDone, 5);
  assert.ok(after.receiptsDetailed > detailedBefore);
  await db.close();
});

test("duplicates: the overlap and repeated ticks never store a receipt or a position twice", async () => {
  const db = new PGlite();
  const sales = makeSales(2);
  const { reader } = fakeKitShop(sales);
  let now = NOW;
  const live = new KitShopLive({ repo: new PgKsRepo(poolOf(db)), reader, now: () => now, options: { ...opts, backfillDays: 3 }, autoAnalytics: false });
  await live.ready();
  for (let i = 0; i < 4; i++) {
    await live.syncNow();
    now += 5 * 60_000;
  }
  const r = await db.query<{ n: number; u: number }>("SELECT count(*)::int AS n, count(DISTINCT sale_id)::int AS u FROM ks_sales");
  const inWindow = sales.filter((s) => s.at >= NOW - 3 * DAY).length;
  assert.equal(r.rows[0].n, r.rows[0].u, "sale_id is unique");
  assert.equal(r.rows[0].n, inWindow);
  const p = await db.query<{ n: number; u: number }>("SELECT count(*)::int AS n, count(DISTINCT (sale_id, position_id))::int AS u FROM ks_positions");
  assert.equal(p.rows[0].n, p.rows[0].u);
  assert.equal(p.rows[0].n, inWindow, "one position per receipt in the fake");
  // re-inserting the same receipt list is a no-op for the primary key
  const repo = new PgKsRepo(poolOf(db));
  await repo.saveSales([{ saleId: sales.at(-1)!.id, shopId: sales.at(-1)!.shop, soldAt: sales.at(-1)!.at, total: 1000, detailed: false }]);
  const again = await db.query<{ n: number; d: boolean }>("SELECT count(*)::int AS n, bool_and(detailed) AS d FROM ks_sales WHERE sale_id = $1", [sales.at(-1)!.id]);
  assert.equal(again.rows[0].n, 1);
  assert.equal(again.rows[0].d, true, "an upsert never resets 'detailed'");
  await db.close();
});

test("GetSaleById failure: the receipt waits for a retry (persisted), the rest of the sync goes on", async () => {
  const db = new PGlite();
  const sales = makeSales(0);
  const failIds = new Set([sales.at(-1)!.id]); // the newest receipt fails
  const { reader, log } = fakeKitShop(sales, { failIds });
  let now = NOW;
  const live = new KitShopLive({ repo: new PgKsRepo(poolOf(db)), reader, now: () => now, options: { ...opts, backfillDays: 1 }, autoAnalytics: false });
  await live.ready();
  const t1 = await live.syncNow();
  const step = t1.steps.find((s) => s.step === "GetSaleById")!;
  assert.equal(step.ok, true, "one bad receipt does not fail the sync");
  assert.equal(step.count, sales.length - 1, "all other receipts detailed");
  const row = await db.query<{ f: number; r: string | null; d: boolean }>("SELECT detail_failures AS f, retry_at::text AS r, detailed AS d FROM ks_sales WHERE sale_id = $1", [sales.at(-1)!.id]);
  assert.equal(row.rows[0].f, 1);
  assert.equal(row.rows[0].d, false);
  assert.ok(Number(row.rows[0].r) > now, "retry is scheduled");
  assert.equal((await live.status()).progress.receiptsRetrying, 1);

  // before the retry time: not requested again
  now += 60_000;
  const calls = log.getSaleById.length;
  await live.syncNow();
  assert.equal(log.getSaleById.length, calls);
  // KiT Shop recovered, retry time passed → detailed
  failIds.clear();
  now += 5 * 60_000;
  await live.syncNow();
  const fixed = await db.query<{ d: boolean }>("SELECT detailed AS d FROM ks_sales WHERE sale_id = $1", [sales.at(-1)!.id]);
  assert.equal(fixed.rows[0].d, true);
  await db.close();
});

test("GetSaleById: a run of failures (KiT Shop down) ends the detail step of this tick early", async () => {
  const sales = makeSales(0);
  const { reader, log } = fakeKitShop(sales, { failIds: new Set(sales.map((s) => s.id)) });
  const live = new KitShopLive({ repo: new PgKsRepo(poolOf(new PGlite())), reader, now: () => NOW, options: { ...opts, backfillDays: 1 }, autoAnalytics: false });
  await live.ready();
  const t = await live.syncNow();
  assert.equal(t.steps.find((s) => s.step === "GetSaleById")!.ok, false);
  assert.equal(log.getSaleById.length, 5, "stops after 5 consecutive failures, does not hammer KiT Shop");
  assert.ok((await live.status()).errors24h.count >= 1);
});

test("load limits: env is clamped to gentle values; never more than 2 parallel GetSaleById", async () => {
  assert.deepEqual(syncOptionsFromEnv({}), { backfillDays: 180, concurrency: 1, delayMs: 300 });
  assert.deepEqual(syncOptionsFromEnv({ KITSHOP_BACKFILL_DAYS: "9999", KITSHOP_BACKFILL_CONCURRENCY: "50", KITSHOP_BACKFILL_DELAY_MS: "-5" }), {
    backfillDays: 365,
    concurrency: 2,
    delayMs: 0,
  });
  assert.equal(syncOptionsFromEnv({ KITSHOP_BACKFILL_CONCURRENCY: "abc" }).concurrency, 1);

  const sales = makeSales(1);
  const one = fakeKitShop(sales, { latencyMs: 2 });
  const l1 = new KitShopLive({ repo: new PgKsRepo(poolOf(new PGlite())), reader: one.reader, now: () => NOW, options: { ...opts, concurrency: 1 }, autoAnalytics: false });
  await l1.ready();
  await l1.syncNow();
  assert.equal(one.log.maxInFlight, 1);
  const two = fakeKitShop(sales, { latencyMs: 2 });
  const l2 = new KitShopLive({ repo: new PgKsRepo(poolOf(new PGlite())), reader: two.reader, now: () => NOW, options: { ...opts, concurrency: 50 }, autoAnalytics: false });
  await l2.ready();
  await l2.syncNow();
  assert.equal(two.log.maxInFlight, 2);

  // the pause after each history request is applied
  const pauses: number[] = [];
  const three = fakeKitShop(makeSales(0));
  const l3 = new KitShopLive({
    repo: new PgKsRepo(poolOf(new PGlite())),
    reader: three.reader,
    now: () => NOW,
    options: { ...opts, backfillDays: 1, delayMs: 250 },
    sleep: async (ms) => void pauses.push(ms),
    autoAnalytics: false,
  });
  await l3.ready();
  await l3.syncNow();
  assert.ok(pauses.length >= three.log.getSaleById.length && pauses.every((p) => p === 250));
});

test("slim memory: after a restart only the last days are in memory; the nightly job reads the history from PostgreSQL", async () => {
  const db = new PGlite();
  const sales = makeSales(10);
  const live1 = new KitShopLive({ repo: new PgKsRepo(poolOf(db)), reader: fakeKitShop(sales).reader, now: () => NOW, options: { ...opts, backfillDays: 12, backfillChunksPerTick: 20 }, autoAnalytics: false });
  await live1.ready();
  await live1.syncNow();
  const total = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ks_sales")).rows[0].n;
  assert.equal(total, sales.length, "the whole history is in the database");

  // restart: memory gets only the last KEEP_DAYS days
  const live2 = new KitShopLive({ repo: new PgKsRepo(poolOf(db)), reader: fakeKitShop(sales).reader, now: () => NOW + 60_000, options: { ...opts, backfillDays: 12 }, autoAnalytics: false });
  await live2.ready();
  assert.ok(live2.ds.slim);
  assert.ok(live2.ds.sales.size < total / 1.5, `memory ${live2.ds.sales.size} of ${total} receipts`);
  assert.ok([...live2.ds.sales.values()].every((s) => s.soldAt >= NOW - 7 * DAY), "only recent receipts in memory");
  const st = await live2.status();
  assert.equal(st.counts.sales, total, "the totals come from the database");
  assert.equal(st.memory.historyRowsInDb !== null && st.memory.historyRowsInDb >= total, true);

  // the nightly job: 180 days per shop from SQL → stats and daily aggregates saved
  const cache = await live2.runAnalyticsNow("test");
  assert.ok(cache);
  assert.equal(cache!.rowsRead.receipts, total, "every receipt read from PostgreSQL, shop by shop");
  const stats = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM product_shop_stats");
  assert.ok(stats.rows[0].n > 0);
  const daily = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM product_shop_daily");
  assert.ok(daily.rows[0].n > 0);
  const saved = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM analytics_cache");
  assert.equal(saved.rows[0].n, 1);

  // a restart takes the saved result at once — no recomputation
  const live3 = new KitShopLive({ repo: new PgKsRepo(poolOf(db)), reader: fakeKitShop(sales).reader, now: () => NOW + 120_000, options: opts, autoAnalytics: false });
  await live3.ready();
  assert.equal(live3.analytics?.runAt, cache!.runAt);
  assert.ok((await live3.snapshot()).productDays!.stats.some((x) => !!x), "norms from the saved result");

  // Завтра: menu and the manager's own number are kept next to the recommendation
  await live3.repo.setMenu("2026-10-14", [{ productId: "101", source: "вручную" }], [], "admin");
  assert.deepEqual((await live3.repo.getMenu("2026-10-14")).map((m) => m.productId), ["101"]);
  await live3.repo.upsertRecommendations("2026-10-14", [{ shopId: SHOPS[0], productId: "101", recommendedQty: 6, recMin: 6, recMax: 7, expectedLeft: 0, confidence: "MEDIUM", reason: null, updatedAt: 1 }]);
  await live3.repo.setManual("2026-10-14", SHOPS[0], "101", 7, "admin");
  await live3.repo.upsertRecommendations("2026-10-14", [{ shopId: SHOPS[0], productId: "101", recommendedQty: 5, recMin: 5, recMax: 6, expectedLeft: 1, confidence: "MEDIUM", reason: null, updatedAt: 2 }]);
  const plan = await live3.repo.getPlan("2026-10-14");
  assert.deepEqual([plan[0].recommendedQty, plan[0].manualQty, plan[0].manualBy], [5, 7, "admin"], "a new recommendation never overwrites the manager's number");
  await db.close();
});
