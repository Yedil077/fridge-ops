import { test } from "node:test";
import assert from "node:assert/strict";
import { KsDataset } from "../src/lib/kitshop-data/dataset";
import { MemoryKsRepo } from "../src/lib/kitshop-data/repo";
import { KitShopSync } from "../src/lib/kitshop-data/sync";
import { compareWithSheet, parseCsv, parseSheetDate, sheetId } from "../src/lib/server/sheetCompare";

/**
 * Сверка KiT Shop ↔ Google Sheets: only reads, never replaces KiT Shop; shows the differences.
 * And the KiT Shop clock: requests are converted to KiT Shop's own clock, the hourly check measures the gap.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 27, 13, 0, 0);
const SHOP = "621287";

function dataset() {
  const ds = new KsDataset();
  ds.products.set("10", { productId: "10", name: "Цезарь", barcode: null, vendorCode: null, price: 1900, groupId: null });
  ds.products.set("11", { productId: "11", name: "Чизкейк", barcode: null, vendorCode: null, price: 1500, groupId: null });
  const at = NOW - 2 * DAY;
  ds.sales.set("500", { saleId: "500", shopId: SHOP, soldAt: at, total: 1900, detailed: true });
  ds.positions.set("500", [{ saleId: "500", positionId: "1", productId: "10", qty: 2, price: 1900 }]);
  ds.fillUps.set("7", { fillupId: "7", shopId: SHOP, at: at - 3_600_000, type: 3, notes: null, userName: "x", detailed: true });
  ds.fillUpLines.set("7", [{ fillupId: "7", lineId: "1", productId: "11", qty: 1 }]);
  return ds;
}

test("CSV and sheet dates are parsed; the sheet id comes only from GOOGLE_SHEET_ID", () => {
  assert.deepEqual(parseCsv('"a","b ""c"""\n"1","2"\n'), [["a", 'b "c"'], ["1", "2"]]);
  assert.equal(parseSheetDate("10/27/2026 16:33:14"), Date.UTC(2026, 9, 27, 16, 33, 14));
  assert.equal(sheetId({}), null);
  assert.equal(sheetId({ GOOGLE_SHEET_ID: "1Ml7TvcX1vV-Z56eVNUXYQYXAeu5BSPDHmQzQ1Ga4N5w" }), "1Ml7TvcX1vV-Z56eVNUXYQYXAeu5BSPDHmQzQ1Ga4N5w");
});

test("comparison: totals per dish, the same receipts' time shift, mismatches listed — sheet read only", async () => {
  const urls: string[] = [];
  const fetcher = async (url: string) => {
    urls.push(decodeURIComponent(url));
    const u = decodeURIComponent(url);
    if (u.includes("select A, D")) return '"SaleId","SaleDateTime"\n"500","10/25/2026 11:00:00"\n'; // ours 13:00 → the sheet is 120 min earlier
    if (u.includes("sheet=CompleteSales")) return '"ProductId","sum Quantity","count SaleId"\n"10","3","3"\n';
    return '"ProductId","FillupType","sum Quantity"\n"11","3","1"\n"10","1","5"\n';
  };
  const r = await compareWithSheet(dataset(), SHOP, NOW, { id: "x".repeat(30), fetcher });
  assert.ok(r.configured);
  if (!r.configured) return;
  assert.equal(r.time.sheetMinusOursMinutes, -120);
  assert.ok(urls.some((u) => u.includes("2026-9-26 22:00:00") && u.includes("2026-10-26 22:00:00")), "the sheet period is shifted by the measured −120 min");
  assert.deepEqual(r.totals.sold, { ours: 2, sheet: 3 });
  assert.deepEqual(r.totals.writtenOff, { ours: 1, sheet: 1 });
  const caesar = r.mismatches.find((m) => m.productId === "10")!;
  assert.deepEqual([caesar.ours.sold, caesar.sheet.sold, caesar.ours.loaded, caesar.sheet.loaded], [2, 3, 0, 5]);
  assert.ok(!r.mismatches.some((m) => m.productId === "11"), "the write-off matches");
  assert.ok(urls.every((u) => u.startsWith("https://docs.google.com/spreadsheets/d/") && u.includes("gviz/tq")), "only the read-only CSV query endpoint");
});

test("not configured → the comparison is off, nothing is fetched", async () => {
  let called = false;
  const r = await compareWithSheet(dataset(), SHOP, NOW, { id: null, fetcher: async () => ((called = true), "") });
  assert.equal(r.configured, false);
  assert.equal(called, false);
});

test("KiT Shop clock: requests use KiT Shop's own clock (offset), the hourly check measures how old the newest receipt is", async () => {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ks = (ms: number) => {
    const d = new Date(ms);
    return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  };
  // KiT Shop runs 2 hours behind our clock: a receipt made "now" carries NOW − 2 h
  const kitNow = NOW - 2 * 3_600_000;
  const receipts = Array.from({ length: 30 }, (_, i) => ({ SaleId: String(900 + i), ShopId: SHOP, SaleDateTime: ks(kitNow - i * 60_000), Sum: 100 }));
  const queries: { from: number; to: number }[] = [];
  const reader = {
    getShops: async () => [{ ShopId: SHOP, ShopName: "Шарипова", StocksAccounting: true }],
    getProducts: async () => [],
    getShopStocks: async () => [],
    getSales: async (q: { from: number; to: number }) => {
      queries.push(q);
      return receipts.filter((r) => {
        const m = /^(\d\d)\.(\d\d)\.(\d{4}) (\d\d):(\d\d):(\d\d)$/.exec(r.SaleDateTime)!;
        const t = Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
        return t >= q.from && t <= q.to;
      });
    },
    getSaleById: async () => null,
  };
  // without the offset: the newest receipt looks 2 hours old
  const ds = new KsDataset();
  await new KitShopSync({ reader: reader as never, repo: new MemoryKsRepo(), ds, now: () => NOW, ourShopIds: [SHOP], options: { backfillDays: 1, delayMs: 0 } }).tick();
  assert.equal(ds.state.clockProbe!.gapMinutes, 120);
  assert.equal(ds.state.clockProbe!.receiptsLastHour, 30);
  // with KITSHOP_TIME_OFFSET_MINUTES=120: requests go out in KiT Shop's clock and the gap is gone
  const ds2 = new KsDataset();
  queries.length = 0;
  await new KitShopSync({ reader: reader as never, repo: new MemoryKsRepo(), ds: ds2, now: () => NOW, ourShopIds: [SHOP], timeOffsetMs: 120 * 60_000, options: { backfillDays: 1, delayMs: 0 } }).tick();
  assert.ok(Math.abs(ds2.state.clockProbe!.gapMinutes) <= 1);
  const fresh = queries.find((q) => q.to === kitNow);
  assert.ok(fresh, "the 'new receipts' request ends at KiT Shop's now, not ours");
  assert.equal(ds2.sales.size, 30, "the newest receipts really arrive");
});
