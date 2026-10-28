import { test } from "node:test";
import assert from "node:assert/strict";
import { KsDataset } from "../src/lib/kitshop-data/dataset";
import { MemoryKsRepo } from "../src/lib/kitshop-data/repo";
import { KitShopSync } from "../src/lib/kitshop-data/sync";
import { clockDiagnostic } from "../src/lib/server/kitshopClock";

/**
 * Time / new-receipt diagnostics on KiT Shop answers: raw SaleDateTime, our parsed time, the gap, the exact From/To
 * sent, and what happened to every returned receipt. The fake KiT Shop runs 2 hours behind our clock and filters by
 * ITS clock, exactly the situation to be proven or disproven on the real one. Only get* methods exist.
 */

const NOW = Date.UTC(2026, 9, 28, 13, 0, 0); // 13:00 Almaty (wall clock)
const SHOP = "621287";
const pad = (n: number) => String(n).padStart(2, "0");
const ks = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
const parse = (s: string) => {
  const m = /^(\d\d)\.(\d\d)\.(\d{4}) (\d\d):(\d\d):(\d\d)$/.exec(s)!;
  return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
};

function fakeKitShop(behindMinutes: number) {
  const kitNow = NOW - behindMinutes * 60_000;
  // a receipt every 2 minutes during the last 3 hours of KiT Shop's clock
  const sales = Array.from({ length: 90 }, (_, i) => ({ SaleId: String(5000 + 90 - i), ShopId: SHOP, SaleDateTime: ks(kitNow - i * 120_000), Sum: 1000 }));
  const sent: { from: string; to: string; shopId?: string }[] = [];
  const reader = {
    getShops: async () => [{ ShopId: SHOP, ShopName: "1 Шарипова 4 этаж", StocksAccounting: true }],
    getProducts: async () => [{ ProductId: "77", ProductName: "Цезарь", Price: 1900 }],
    getShopStocks: async () => [],
    getSales: async (q: { from: number; to: number; shopId?: string }) => {
      sent.push({ from: ks(q.from), to: ks(q.to), shopId: q.shopId });
      return sales.filter((s) => parse(s.SaleDateTime) >= q.from && parse(s.SaleDateTime) <= q.to);
    },
    getSaleById: async (id: string) => {
      const s = sales.find((x) => x.SaleId === id)!;
      return { ...s, Positions: [{ PositionId: `${id}1`, ProductId: "77", Quantity: 1, Price: 1900 }] };
    },
  };
  return { reader: new Proxy(reader, { get: (t, p: string) => (p.startsWith("get") ? (t as Record<string, unknown>)[p] : undefined) }) as never, sent, kitNow };
}

test("diagnostic: newest receipt raw time from KiT Shop, our parsed time and the gap — proves a 120-minute shift", async () => {
  const k = fakeKitShop(120);
  const ds = new KsDataset();
  const d = await clockDiagnostic({ reader: k.reader, ds, shopId: SHOP, shopName: "1 Шарипова 4 этаж", offsetMinutes: 0, now: NOW, lastSalesSyncAt: NOW - 5 * 60_000, overlapMs: 15 * 60_000 });
  assert.equal(d.nowAlmaty, "28.10.2026 13:00:00");
  assert.equal(d.newest!.saleId, "5090");
  assert.equal(d.newest!.raw, "28.10.2026 11:00:00", "the raw string exactly as KiT Shop returned it");
  assert.equal(d.newest!.parsed, "28.10.2026 11:00:00");
  assert.equal(d.newest!.ageMinutes, 120);
  assert.equal(d.newest!.receiptsInItsLastHour, 30);
  // the sync's own request: From/To in OUR clock → KiT Shop has nothing in that window yet
  assert.equal(d.syncRequestNow.fromSent, "28.10.2026 12:40:00");
  assert.equal(d.syncRequestNow.toSent, "28.10.2026 13:00:00");
  assert.equal(d.syncRequestNow.returned, 0, "this is why new receipts never arrive");
  assert.equal(d.last3.length, 3);
  assert.deepEqual(d.last3[0].lines, [{ productId: "77", name: "#77", qty: 1 }]);
  assert.equal(d.last3[0].inKsSales, false);
});

test("diagnostic with the proven offset (+120): the gap is gone and the sync's request returns the newest receipts", async () => {
  const k = fakeKitShop(120);
  const d = await clockDiagnostic({ reader: k.reader, ds: new KsDataset(), shopId: SHOP, shopName: "x", offsetMinutes: 120, now: NOW, lastSalesSyncAt: NOW - 5 * 60_000, overlapMs: 15 * 60_000 });
  assert.equal(d.newest!.raw, "28.10.2026 11:00:00");
  assert.equal(d.newest!.parsed, "28.10.2026 13:00:00");
  assert.equal(d.newest!.ageMinutes, 0);
  assert.equal(d.syncRequestNow.fromSent, "28.10.2026 10:40:00", "sent in KiT Shop's clock");
  assert.equal(d.syncRequestNow.returned, 11);
  assert.equal(d.syncRequestNow.notYetInKsSales, 11);
});

test("the sync logs every 'new receipts' request: From/To sent, returned, min/max raw, written, duplicates, why not written", async () => {
  const k = fakeKitShop(0);
  const ds = new KsDataset();
  let now = NOW;
  const sync = new KitShopSync({ reader: k.reader, repo: new MemoryKsRepo(), ds, now: () => now, ourShopIds: [SHOP], options: { backfillDays: 1, delayMs: 0 } });
  await sync.tick();
  const first = ds.state.lastNewSales!;
  assert.equal(first.fromSent, "27.10.2026 13:00:00");
  assert.equal(first.toSent, "28.10.2026 13:00:00");
  assert.equal(first.returned, 90);
  assert.equal(first.written, 90);
  assert.equal(first.minRaw, "28.10.2026 10:02:00");
  assert.equal(first.maxRaw, "28.10.2026 13:00:00");
  now += 5 * 60_000;
  await sync.tick();
  const second = ds.state.lastNewSales!;
  assert.equal(second.fromSent, "28.10.2026 12:45:00", "15-minute overlap");
  assert.equal(second.returned, 8);
  assert.equal(second.duplicates, 8, "the overlap is skipped, never stored twice");
  assert.equal(second.written, 0);
  assert.equal(second.badDate, 0);
});
