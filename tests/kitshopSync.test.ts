import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { KsDataset } from "../src/lib/kitshop-data/dataset";
import { MemoryKsRepo } from "../src/lib/kitshop-data/repo";
import { KitShopSync } from "../src/lib/kitshop-data/sync";
import { buildKitShopSnapshot, isFood } from "../src/lib/kitshop-data/snapshot";
import { configuredFridges } from "../src/lib/simulator/model";
import { categorize } from "../src/services/kitshop/adapter";
import { dayNumber } from "../src/lib/time";

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
/** wall ms → KiT Shop "dd.MM.yyyy HH:mm:ss" */
const ks = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const SHOP = "621136"; // 3 Досмухамедова Восток (configured)

/**
 * Fake read-only KiT Shop. Every access is recorded; anything that is not a get* method throws,
 * so a test fails if sync ever tries to write.
 */
function fakeReader(sales: { id: string; at: number; shop?: string; positions: { pid: string; qty: number; price: number }[] }[]) {
  const calls: string[] = [];
  const impl = {
    async getShops() {
      return [{ ShopId: SHOP, ShopName: "3 Досмухамедова Восток 3 этаж", StocksAccounting: true }];
    },
    async getProducts() {
      return [
        { ProductId: "101", ProductName: "Праздничный плов", Price: 1890 },
        { ProductId: "102", ProductName: "Салат \"Цезарь\" с курочкой", Price: 1690 },
        { ProductId: "103", ProductName: "Ягодный морс 500мл", Price: 690 },
        { ProductId: "104", ProductName: "Столовые приборы", Price: 0 },
      ];
    },
    async getShopStocks(shopId: string) {
      return shopId === SHOP ? [{ ProductId: "101", Quantity: 4 }, { ProductId: "102", Quantity: 2 }, { ProductId: "104", Quantity: 50 }] : [];
    },
    async getSales(q: { from: number; to: number }) {
      return sales
        .filter((s) => s.at >= q.from && s.at < q.to)
        .map((s) => ({ SaleId: s.id, ShopId: s.shop ?? SHOP, SaleDateTime: ks(s.at), Sum: s.positions.reduce((a, p) => a + p.qty * p.price, 0) }));
    },
    async getSaleById(id: string) {
      const s = sales.find((x) => x.id === id)!;
      return {
        SaleId: s.id,
        ShopId: s.shop ?? SHOP,
        SaleDateTime: ks(s.at),
        Positions: s.positions.map((p, i) => ({ PositionId: `${id}-${i}`, ProductId: p.pid, Quantity: p.qty, Price: p.price })),
      };
    },
  };
  const reader = new Proxy(impl, {
    get(t, prop: string) {
      calls.push(prop);
      if (!prop.startsWith("get")) throw new Error(`write-like access: ${prop}`);
      return (t as Record<string, unknown>)[prop];
    },
  });
  return { reader: reader as unknown as ConstructorParameters<typeof KitShopSync>[0]["reader"], calls };
}

function setup(sales: Parameters<typeof fakeReader>[0], options = {}) {
  const ds = new KsDataset();
  let now = NOW;
  const { reader, calls } = fakeReader(sales);
  const sync = new KitShopSync({ reader, repo: new MemoryKsRepo(), ds, now: () => now, ourShopIds: [SHOP], options: { backfillDays: 5, backfillChunksPerTick: 2, ...options } });
  return { ds, sync, calls, setNow: (t: number) => (now = t) };
}

const sale = (id: string, at: number, pid = "101", qty = 1) => ({ id, at, positions: [{ pid, qty, price: 1000 }] });

test("sync: catalog, stock, today's receipts with product lines — only get* methods", async () => {
  const { ds, sync, calls } = setup([sale("1", NOW - 3_600_000), sale("2", NOW - 1_800_000, "102", 2)]);
  const res = await sync.tick();
  assert.ok(res.ok, JSON.stringify(res.steps));
  assert.equal(ds.shops.size, 1);
  assert.equal(ds.products.size, 4);
  assert.equal(ds.stock.get(SHOP)?.get("101"), 4);
  assert.equal(ds.sales.size, 2);
  assert.equal(ds.positions.get("2")?.[0].qty, 2);
  assert.ok([...ds.sales.values()].every((s) => s.detailed));
  assert.equal(ds.state.lastSuccessAt, NOW);
  assert.ok(ds.state.lastCatalogSyncAt && ds.state.lastStockSyncAt && ds.state.lastSalesSyncAt);
  assert.ok(calls.every((c) => c.startsWith("get")), `calls: ${calls}`);
});

test("sync: incremental with overlap never duplicates, backfill walks back in chunks to 180 (here 5) days", async () => {
  const sales = [sale("old4", NOW - 4 * DAY), sale("old2", NOW - 2 * DAY), sale("a", NOW - 600_000)];
  const { ds, sync, setNow } = setup(sales);
  await sync.tick();
  // first tick: today + 2 backfill chunks of 1 day → reached NOW-3d
  assert.ok(ds.sales.has("a") && ds.sales.has("old2"));
  assert.ok(!ds.sales.has("old4"));
  assert.equal(sync.backlog().backfillDaysLeft, 2);
  // 5 minutes later: one new receipt; the overlap re-reads "a" but it is not duplicated
  sales.push(sale("b", NOW + 120_000));
  setNow(NOW + 5 * 60_000);
  await sync.tick();
  assert.ok(ds.sales.has("b") && ds.sales.has("old4"));
  assert.equal(ds.sales.size, 4);
  assert.equal(sync.backlog().backfillDaysLeft, 0);
  assert.equal(sync.backlog().undetailed, 0);
});

test("sync: receipt details are budgeted per tick, newest first", async () => {
  const sales = Array.from({ length: 10 }, (_, i) => sale(String(i), NOW - (i + 1) * 60_000));
  const { ds, sync } = setup(sales, { detailsPerTick: 3 });
  await sync.tick();
  const detailed = [...ds.sales.values()].filter((s) => s.detailed).map((s) => s.saleId).sort();
  assert.deepEqual(detailed, ["0", "1", "2"]);
  assert.equal(sync.backlog().undetailed, 7);
});

test("sync: KiT Shop down → error recorded, cached data kept, never throws", async () => {
  const { ds, sync } = setup([sale("1", NOW - 60_000)]);
  await sync.tick();
  const broken = new KitShopSync({
    reader: new Proxy({}, { get: () => async () => { throw new Error("ECONNRESET"); } }) as never,
    repo: new MemoryKsRepo(),
    ds,
    now: () => NOW + 10 * 60_000,
    ourShopIds: [SHOP],
  });
  const res = await broken.tick();
  assert.equal(res.ok, false);
  assert.match(ds.state.lastError ?? "", /ECONNRESET/);
  assert.equal(ds.sales.size, 1, "cache stays");
  assert.equal(ds.state.lastSuccessAt, NOW, "last success is not moved by a failed tick");
});

test("snapshot: built only from the KiT Shop copy — today's sales, stock, history, non-food excluded", async () => {
  const sales = [sale("t1", NOW - 3_600_000, "101", 2), sale("t2", NOW - 600_000, "103", 1), sale("y1", NOW - DAY, "102", 3)];
  const { ds, sync } = setup(sales);
  await sync.tick();
  const snap = buildKitShopSnapshot(ds, configuredFridges(dayNumber(NOW)), NOW);
  assert.equal(snap.source, "kitshop");
  assert.equal(snap.fridges.length, 1, "only points that exist in KiT Shop");
  assert.equal(snap.fridges[0].externalId, SHOP);
  assert.ok(!snap.products.some((p) => p.name === "Столовые приборы"), "cutlery is not a dish");
  const P = snap.products.length;
  const pi = (pid: string) => snap.products.findIndex((p) => p.externalId === pid);
  assert.equal(snap.today.productSales[pi("101")], 2);
  assert.equal(snap.today.productSales[pi("103")], 1);
  assert.equal(snap.stock[pi("101")], 4);
  assert.equal(snap.history.productDaily[(0 * P + pi("102")) * snap.history.days + (snap.history.days - 1)], 3, "yesterday is history");
  assert.equal(snap.today.revenue[0], 3000);
});

test("categories of real Green City dishes", () => {
  assert.equal(categorize("Праздничный плов"), "hot");
  assert.equal(categorize("Салат \"Цезарь\" с курочкой"), "salad");
  assert.equal(categorize("Ягодный морс 500мл"), "drink");
  assert.equal(categorize("Творожные сырники со сметаной"), "breakfast");
  assert.equal(categorize("Кесадилья с курицей"), "snack");
  assert.equal(categorize("Киш с лососем и брокколи"), "snack");
  assert.equal(categorize("Чизкейк Нью-Йорк"), "dessert");
  assert.ok(isFood("Боксмастер", 1490));
  assert.ok(!isFood("Пакет", 50));
});

// ───────────────────────── production read-only mode ─────────────────────────

const root = path.join(__dirname, "..");
const code = (p: string) => fs.readFileSync(path.join(root, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("read-only production path: sync / snapshot / live service call only get* readers", () => {
  for (const f of ["src/lib/kitshop-data/sync.ts", "src/lib/kitshop-data/snapshot.ts", "src/lib/kitshop-data/repo.ts", "src/lib/kitshop-data/dataset.ts", "src/lib/server/kitshopLive.ts"]) {
    const src = code(f);
    assert.doesNotMatch(src, /makeFillUp|addProduct|MakeFillUp|AddProduct|CreateProduct|UpdateProduct|DeleteProduct|AddCommand|adapterFor|catalogAdapter|KitShopLiveWriter/, `${f} must not reach write code`);
    const reads = [...src.matchAll(/reader\.(\w+)\(/g)].map((m) => m[1]);
    assert.ok(reads.every((m) => m.startsWith("get")), `${f}: ${reads}`);
  }
});

test("read-only production path: runtime refuses writes and never sends transfer legs", () => {
  const rt = code("src/lib/server/runtime.ts");
  assert.match(rt, /readonly readOnly = kitshopReadOnly\(\);/);
  assert.match(rt, /submitOperation\([\s\S]*?\{\s*this\.assertWritable\(/, "loads / unloads / write-offs are refused first");
  assert.match(rt, /private startTransfer\([^)]*\) \{\s*if \(this\.readOnly\) return;/, "missions never create KiT Shop legs");
  assert.match(rt, /createInKitShop\([^)]*\) \{\s*this\.assertWritable\(/, "product creation is refused");
  assert.match(rt, /if \(!rt\.readOnly\)\s*setInterval\(/, "the background sender of pending operations does not run");
  const gate = code("src/lib/server/kitshopWrite.ts");
  assert.match(gate, /return process\.env\.KITSHOP_READ_ONLY !== "false";/, "read-only unless explicitly switched off");
  assert.match(gate, /const open = !kitshopReadOnly\(\) && /, "the live writer is never constructed in read-only mode");
  const admin = code("src/app/api/admin/kitshop/route.ts");
  assert.match(admin, /rt\.readOnly && \["test-start", "test-prepare", "test-confirm"/);
  const retry = code("src/app/api/ops/[id]/route.ts");
  assert.match(retry, /if \(rt\.readOnly\) throw new HttpError\(403/);
});

test("read-only production path: even with every write flag on, no live adapter exists", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    KITSHOP_ENABLED: "true",
    KITSHOP_COMPANY_ID: "1",
    KITSHOP_LOGIN: "test",
    KITSHOP_PASSWORD: "test",
    KITSHOP_WRITE_ENABLED: "true",
    KITSHOP_WRITE_DRY_RUN: "false",
    KITSHOP_WRITE_SHOPS: SHOP,
    KITSHOP_WRITE_SCOPE: "all",
  });
  delete process.env.KITSHOP_READ_ONLY;
  delete (globalThis as { __kitshopServer?: unknown }).__kitshopServer;
  try {
    const w = await import("../src/lib/server/kitshopWrite");
    assert.equal(w.kitshopReadOnly(), true);
    assert.notEqual(w.adapterFor(SHOP, "write-test").mode, "live");
    assert.notEqual(w.adapterFor(SHOP).mode, "live");
    assert.notEqual(w.catalogAdapter().mode, "live");
    assert.equal(w.kitshopServerInfo().liveOpen, false);
  } finally {
    delete (globalThis as { __kitshopServer?: unknown }).__kitshopServer;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("categories: the KiT Shop product group wins, the dish name is only a fallback", async () => {
  const { categorizeProduct, categoryFromGroup } = await import("../src/services/kitshop/adapter");
  assert.deepEqual(categorizeProduct("Микс здоровья", "Салаты"), { category: "salad", by: "group" });
  assert.deepEqual(categorizeProduct("Праздничный плов", "Green City"), { category: "hot", by: "name" });
  assert.deepEqual(categorizeProduct("Цезарь с курицей", null), { category: "salad", by: "name" });
  assert.equal(categoryFromGroup("Горячие блюда"), "hot");
  assert.equal(categoryFromGroup("Напитки"), "drink");
  assert.equal(categoryFromGroup("Основная"), null);
});

test("shadow mode: real sync runs, users keep the simulator, nothing switches by itself", () => {
  const rt = code("src/lib/server/runtime.ts");
  assert.match(rt, /this\.mode = process\.env\.DATA_SOURCE === "kitshop" \? "kitshop" : "mock";/, "only DATA_SOURCE=kitshop shows real data");
  assert.match(rt, /this\.shadow = process\.env\.DATA_SOURCE === "kitshop_shadow";/);
  assert.match(rt, /if \(rt\.mode === "kitshop" \|\| rt\.shadow\) kitshopLive\(\);/, "shadow starts the read-only sync");
  assert.match(rt, /if \(this\.mode === "mock"\) return \{ label: "SIMULATOR"/, "users see SIMULATOR in shadow mode");
  assert.match(rt, /if \(this\.mode === "mock" && this\.sim\) return this\.withSettings\(this\.sim\.snapshot\(\)\);/, "screens read the simulator");
});
