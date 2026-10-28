import { test } from "node:test";
import assert from "node:assert/strict";
import { KsDataset } from "../src/lib/kitshop-data/dataset";
import { buildKitShopSnapshot } from "../src/lib/kitshop-data/snapshot";
import { configuredFridges } from "../src/lib/simulator/model";
import { analyze } from "../src/lib/engine/analysis";
import { computeTomorrow } from "../src/lib/engine/tomorrow";

/**
 * ЗАВТРА: the menu is given; the app only says how many — whole units, the norm minus what is still fresh tomorrow
 * morning, "?" when there is nothing to count on, 0 when the fridge does not work that weekday.
 */

const DAY = 86_400_000;
const H = 3_600_000;
const TODAY = 20_750;
const NOW = TODAY * DAY + 13 * H;
const t = (d: number, h: number, m = 0) => d * DAY + h * H + m * 60_000;
const S1 = "621583";
const S2 = "621826";

function dataset() {
  const ds = new KsDataset();
  ds.shops.set(S1, { shopId: S1, name: "5 БЦ Сатти 1 этаж", stocksAccounting: true });
  ds.shops.set(S2, { shopId: S2, name: "6 БЦ Сатти А2 этаж", stocksAccounting: true });
  ds.products.set("1", { productId: "1", name: "Сосиска в тесте", barcode: null, vendorCode: null, price: 700, groupId: null });
  ds.products.set("4", { productId: "4", name: "Ягодный морс", barcode: null, vendorCode: null, price: 500, groupId: null });
  ds.products.set("9", { productId: "9", name: "Новый пирог", barcode: null, vendorCode: null, price: 900, groupId: null });
  let sid = 0;
  let fid = 0;
  const sale = (shop: string, at: number, pid: string) => {
    const id = String(++sid);
    ds.sales.set(id, { saleId: id, shopId: shop, soldAt: at, total: 700, detailed: true });
    ds.positions.set(id, [{ saleId: id, positionId: id, productId: pid, qty: 1, price: 700 }]);
  };
  const fill = (shop: string, at: number, pid: string, qty: number, type: 1 | 2 | 3) => {
    const id = String(++fid);
    ds.fillUps.set(id, { fillupId: id, shopId: shop, at, type, notes: null, userName: "t", detailed: true });
    ds.fillUpLines.set(id, [{ fillupId: id, lineId: "0", productId: pid, qty }]);
  };
  for (const shop of [S1, S2])
    for (let d = TODAY - 40; d < TODAY; d++) {
      fill(shop, t(d, 7), "4", 1, 1);
      sale(shop, t(d, 12), "4");
    }
  // S1 «Сосиска»: every 2nd day 7 put → 6 sold in 48 h, 1 written off; today 7 put at 07:00, 5 sold by 13:00
  for (let d = TODAY - 30; d < TODAY - 2; d += 2) {
    fill(S1, t(d, 7), "1", 7, 1);
    for (const h of [9, 11, 14]) sale(S1, t(d, h), "1");
    for (const h of [9, 11, 14]) sale(S1, t(d + 1, h), "1");
    fill(S1, t(d + 2, 8), "1", 1, 3);
  }
  fill(S1, t(TODAY, 7), "1", 7, 1);
  for (const m of [0, 30, 60, 90, 120]) sale(S1, t(TODAY, 9) + m * 60_000, "1");
  ds.stock.set(S1, new Map([["1", 2]]));
  ds.stock.set(S2, new Map());
  for (const s of [S1, S2]) ds.stockAt.set(s, NOW);
  ds.state.backfillFrom = t(TODAY - 41, 0);
  ds.state.fillupsBackfillFrom = t(TODAY - 41, 0);
  ds.state.lastSuccessAt = NOW;
  return ds;
}

function plan(menu: string[], receiptsByDay?: (shopId: string, day: number) => number | null) {
  const fridges = configuredFridges(TODAY).filter((f) => f.externalId === S1 || f.externalId === S2);
  const snap = buildKitShopSnapshot(dataset(), fridges, NOW);
  const a = analyze(snap, { forecastBias: {}, pairStats: {} }, []);
  const cells = computeTomorrow({ snap, forecasts: a.forecasts, stats: a.products, menu, day: TODAY + 1, receiptsByDay });
  return { cells, cell: (shop: string, pid: string) => cells.find((c) => c.shopId === shop && c.productId === pid)! };
}

test("the norm minus what is still fresh tomorrow morning; whole units; why", () => {
  const { cell } = plan(["K1"]);
  const c = cell(S1, "K1");
  assert.equal(c.base, 6, "7→6 every time: ставить 6");
  assert.ok(c.expectedLeft >= 0 && c.expectedLeft <= 2, `today's 2 left minus what sells until tonight → ${c.expectedLeft}`);
  assert.equal(c.qty, 6 - c.expectedLeft);
  assert.ok(Number.isInteger(c.qty));
  assert.deepEqual(c.reason.today, { loaded: 7, soldSoFar: 5 }, "TODAY: 5 of 7 already sold");
  assert.ok(c.reason.deliveries.length >= 3 && c.reason.deliveries.every((d) => d.loaded === 7 && d.sold === 6 && d.writtenOff === 1));
  assert.equal(c.basis, "ЭТА ТОЧКА");
  assert.equal(c.reason.writeOff, "среднее", "1 of 7 (14%) written off every time");
});

test("a fridge that never had the dish: the same dish in its transfer group first (SATTI) — НОВЫЙ, low confidence", () => {
  const { cell } = plan(["K1"]);
  const c = cell(S2, "K1");
  assert.equal(c.tag, "НОВЫЙ");
  assert.equal(c.basis, "ГРУППА", "SATTI 1 and SATTI A2 are in one transfer group");
  assert.equal(c.confidence, "LOW");
  assert.equal(c.qty, 6, "the norm of the same dish in the group");
});

test("no data anywhere → '?' (no invented number)", () => {
  const { cell } = plan(["K9"]);
  assert.equal(cell(S1, "K9").qty, null);
  assert.equal(cell(S1, "K9").tag, "НОВЫЙ");
});

test("the fridge does not work on that weekday → 0", () => {
  const { cell } = plan(["K1"], (shop, day) => (shop === S1 ? (day < TODAY ? 0 : null) : 5));
  assert.equal(cell(S1, "K1").qty, 0);
  assert.equal(cell(S1, "K1").tag, "НЕ РАБОТАЕТ");
});
