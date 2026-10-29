import { test } from "node:test";
import assert from "node:assert/strict";
import { KsDataset } from "../src/lib/kitshop-data/dataset";
import { buildKitShopSnapshot, fillDirection } from "../src/lib/kitshop-data/snapshot";
import { configuredFridges } from "../src/lib/simulator/model";
import { analyze } from "../src/lib/engine/analysis";
import { quantile } from "../src/lib/engine/productNorm";
import type { ShelfLifeSettings } from "../src/lib/config/shelfLife";
import { productAnalyticsView } from "../src/lib/server/productAnalyticsView";

/**
 * PRODUCT × FRIDGE analytics on real-shaped KiT Shop data (receipts, loads / unloads / write-offs, stock history) —
 * never the simulator. Everything a person sees is a whole number of units.
 */

const DAY = 86_400_000;
const H = 3_600_000;
const S = 20_000;
const t = (day: number, h: number, m = 0) => day * DAY + h * H + m * 60_000;

test("fill-up direction comes from the KiT Shop operation type: unload and write-off quantities arrive positive", () => {
  assert.deepEqual(fillDirection(1, 5), { delta: 5, kind: "load" });
  assert.deepEqual(fillDirection(2, 3), { delta: -3, kind: "unload" }, "Разгрузка = снято, not a write-off");
  assert.deepEqual(fillDirection(3, 2), { delta: -2, kind: "writeoff" }, "Списание = confirmed write-off");
  assert.deepEqual(fillDirection(2, -3), { delta: -3, kind: "unload" });
  assert.deepEqual(fillDirection(null, -1), { delta: -1, kind: "unload" });
});

test("quantiles are always one of the real whole values", () => {
  assert.equal(quantile([1, 1, 2, 2, 3], 0.25), 1);
  assert.equal(quantile([1, 1, 2, 2, 3], 0.75), 2);
  assert.equal(quantile([1, 1, 2, 2, 3], 0.9), 3);
  assert.equal(quantile([4], 0.5), 4);
});

// ───────────── one real-shaped fridge: deliveries over 40 days ─────────────

const SATTI1 = "621583";
const TODAY = 20_750; // 2026-10-24
const NOW = t(TODAY, 13);

/**
 * «Сосиска в тесте» (48 h): in the menu only every 6th day — 7 put, 6 sold in 48 h, 1 written off (type 3); the last
 *   delivery 3 days ago: 7 put, 4 sold, 3 still in the fridge (older than 48 h now).
 * «Салат Цезарь» (48 h): deliveries 7,7,6,7,6 → sold 6,7,6,5,6, the rest unloaded (type 2); today 3 put.
 * «Чизкейк» (72 h): 4 every 3 days, all 4 sold every time.
 * «Морс»: 3 put and 3 sold every day (the fridge works every day).
 */
function fridgeDataset() {
  const ds = new KsDataset();
  ds.shops.set(SATTI1, { shopId: SATTI1, name: "5 БЦ Сатти 1 этаж", stocksAccounting: true });
  const names: Record<string, string> = { "1": "Сосиска в тесте", "2": "Салат Цезарь", "3": "Творожный чизкейк", "4": "Ягодный морс" };
  for (const [id, name] of Object.entries(names)) ds.products.set(id, { productId: id, name, barcode: null, vendorCode: null, price: 900, groupId: null });
  let sid = 0;
  let fid = 0;
  const sale = (at: number, pid: string, qty = 1) => {
    const id = String(++sid);
    ds.sales.set(id, { saleId: id, shopId: SATTI1, soldAt: at, total: 900 * qty, detailed: true });
    ds.positions.set(id, [{ saleId: id, positionId: id, productId: pid, qty, price: 900 }]);
  };
  // KiT Shop: quantities of unloads / write-offs come positive, the type says what it is
  const fill = (at: number, pid: string, qty: number, type: 1 | 2 | 3) => {
    const id = String(++fid);
    ds.fillUps.set(id, { fillupId: id, shopId: SATTI1, at, type, notes: null, userName: "test", detailed: true });
    ds.fillUpLines.set(id, [{ fillupId: id, lineId: "0", productId: pid, qty }]);
  };
  for (let d = TODAY - 40; d < TODAY; d++) {
    fill(t(d, 7), "4", 3, 1);
    for (const m of [0, 10, 20]) sale(t(d, 12, m), "4");
  }
  for (const d of [TODAY - 37, TODAY - 31, TODAY - 25, TODAY - 19, TODAY - 13, TODAY - 7]) {
    fill(t(d, 7), "1", 7, 1);
    for (const h of [10, 12, 15]) sale(t(d, h), "1");
    for (const h of [10, 12, 15]) sale(t(d + 1, h), "1");
    fill(t(d + 2, 8), "1", 1, 3);
  }
  fill(t(TODAY - 3, 7), "1", 7, 1);
  for (const h of [10, 11, 12, 15]) sale(t(TODAY - 3, h), "1");
  const caesar: [number, number, number][] = [
    [TODAY - 20, 7, 6],
    [TODAY - 16, 7, 7],
    [TODAY - 12, 6, 6],
    [TODAY - 8, 7, 5],
    [TODAY - 4, 6, 6],
  ];
  for (const [d, put, soldN] of caesar) {
    fill(t(d, 7), "2", put, 1);
    for (let k = 0; k < soldN; k++) sale(t(d, 9) + k * 3 * H, "2");
    if (put > soldN) fill(t(d + 2, 8), "2", put - soldN, 2);
  }
  fill(t(TODAY, 7), "2", 3, 1);
  for (const d of [TODAY - 15, TODAY - 12, TODAY - 9, TODAY - 6, TODAY - 3]) {
    fill(t(d, 7), "3", 4, 1);
    sale(t(d, 10), "3");
    sale(t(d, 12), "3");
    sale(t(d + 1, 10), "3");
    sale(t(d + 2, 10), "3");
  }
  ds.stock.set(SATTI1, new Map([["1", 3], ["2", 3]]));
  ds.stockAt.set(SATTI1, NOW);
  ds.state.backfillFrom = t(TODAY - 41, 0);
  ds.state.fillupsBackfillFrom = t(TODAY - 41, 0);
  ds.state.lastSuccessAt = NOW;
  return ds;
}

function analysed(ds = fridgeDataset(), shelfLife?: ShelfLifeSettings) {
  const fridges = configuredFridges(TODAY).filter((f) => f.externalId === SATTI1);
  const snap = buildKitShopSnapshot(ds, fridges, NOW, { shelfLife });
  const a = analyze(snap, { forecastBias: {}, pairStats: {} }, [], "realtime", undefined, { shelfLife });
  const at = (name: string) => a.products.at[snap.products.findIndex((x) => x.name.includes(name))]!;
  return { snap, a, S: at("Сосиска"), C: at("Цезарь"), K: at("чизкейк") };
}

const isWhole = (x: unknown): boolean =>
  typeof x === "number" ? Number.isInteger(x) : Array.isArray(x) ? x.every(isWhole) : x && typeof x === "object" ? Object.values(x).every(isWhole) : true;

test("every quantity a person sees is a whole number of units (sell-through only as a share)", () => {
  const { snap, a } = analysed();
  const v = productAnalyticsView(snap, a, null, "20:00");
  for (const r of v.products) {
    const { sellThrough, ...rest } = r.batches;
    void sellThrough;
    for (const [k, val] of Object.entries({ sold: r.sold, batches: rest, recent: r.recent, ages: r.ages, plan: r.plan, norm: r.norm, today: r.today, stock: r.stock, expired: r.expiredNow }))
      assert.ok(isWhole(val), `${r.name}.${k} = ${JSON.stringify(val)}`);
    for (const w of [...r.why, r.recommendation]) assert.ok(!/\d+[.,]\d/.test(w), `no fractions in «${w}»`); // dd.mm dates are fine
  }
});

test("«Сосиска в тесте»: deliveries, not calendar days — in the menu 7 times in 40 days, put 7 → ставить 6", () => {
  const { S } = analysed();
  assert.equal(S.shelfHours, 48);
  assert.equal(S.batches.count, 7);
  assert.equal(S.batches.loaded, 49);
  assert.equal(S.batches.sold, 40);
  assert.equal(S.batches.writtenOff, 6, "type 3 «Списание»");
  assert.equal(S.batches.unloaded, 0);
  assert.deepEqual(S.batches.usualLoaded, { low: 7, high: 7 });
  assert.deepEqual(S.batches.usualSold, { low: 6, high: 6 });
  assert.equal(S.norm!.rec, 6, "what sells within 48 h, not 0.x per day");
  assert.equal(S.status, "LESS", "usually 7 were put");
  assert.equal(S.recommendation, "Ставить 6 шт.");
  // 3 units of the delivery 3 days ago are older than 48 h: they do not count as stock for today's delivery
  assert.equal(S.expiredNow, 3);
  assert.deepEqual(S.plan, { target: 6, fresh: 0, delivery: 6 });
  assert.ok(S.salesDays30 < 15, "most days it simply was not in the menu — and that did not pull the norm down");
});

test("«Цезарь»: 7→6, 7→7, 6→6, 7→5, 6→6 → ставить 6 (6–7); today's delivery counts what is already there", () => {
  const { C } = analysed();
  assert.equal(C.batches.count, 5);
  assert.equal(C.batches.open, 1, "today's delivery is still selling");
  assert.deepEqual(C.norm, { min: 6, rec: 6, max: 7 });
  assert.equal(C.batches.unloaded, 3, "type 2 «Разгрузка» → снято, not written off");
  assert.equal(C.batches.writtenOff, 0);
  assert.deepEqual(C.plan, { target: 6, fresh: 3, delivery: 3 });
  assert.deepEqual(C.recent[0].loaded, 3);
  assert.equal(C.recent[0].complete, false);
});

test("«Чизкейк» (72 h): the last 3 deliveries sold out → +1", () => {
  const { K } = analysed();
  assert.equal(K.shelfHours, 72);
  assert.ok(K.recent.slice(0, 3).every((b) => b.soldOut));
  assert.equal(K.norm!.rec, 5);
  assert.equal(K.status, "MORE");
  assert.ok(K.why.some((w) => w.includes("ушли полностью")));
});

test("shelf life per dish (Настройки): 24 h instead of 72 h → only what sold in 24 h counts", () => {
  const { snap } = analysed();
  const cheesecake = snap.products.find((p) => p.name.includes("чизкейк"))!;
  const { K } = analysed(fridgeDataset(), { categories: {}, products: { [cheesecake.id]: 24 } });
  assert.equal(K.shelfHours, 24);
  assert.equal(K.shelfSource, "product");
  assert.equal(K.norm!.rec, 2, "2 of 4 sell within 24 h");
});

test("analytics view: today's transfer numbers are the demand cells; continuity and checks are shown", () => {
  const { snap, a } = analysed();
  const v = productAnalyticsView(snap, a, null, "20:00");
  for (const r of v.products) {
    const cell = a.demand.NOW.products[snap.products.findIndex((x) => x.id === r.productId)]!;
    assert.deepEqual([r.today!.need, r.today!.surplus], [cell.need, cell.surplus]);
  }
  assert.equal(v.fridge.continuity.length, 30);
  assert.ok(v.fridge.continuity.every((d) => d.status === "DATA"));
  const ids = v.fridge.checks.map((c) => c.id);
  for (const id of ["continuity", "fill-types", "clock", "fresh", "stock", "timezone", "ids-shop"]) assert.ok(ids.includes(id), id);
  assert.equal(v.fridge.checks.find((c) => c.id === "continuity")!.level, "OK");
});

test("a day without receipts while the fridge works = DATA GAP → no norm at all", () => {
  const ds = fridgeDataset();
  const gapDay = TODAY - 5;
  for (const [id, s] of ds.sales) if (Math.floor(s.soldAt / DAY) === gapDay) ds.sales.delete(id);
  const { snap, C } = analysed(ds);
  const c = snap.productDays!.checks[0].find((x) => x.id === "continuity")!;
  assert.equal(c.level, "FAIL");
  assert.ok(c.detail.includes("DATA GAP"));
  assert.equal(C.norm, null);
  assert.ok(C.recommendation.startsWith("ДАННЫЕ НЕПОЛНЫЕ"));
});

test("a failed check (receipts from the future = wrong timezone) → ДАННЫЕ НЕПОЛНЫЕ, no norm, no transfers", () => {
  const ds = fridgeDataset();
  ds.sales.set("future", { saleId: "future", shopId: SATTI1, soldAt: NOW + 2 * H, total: 1, detailed: true });
  ds.positions.set("future", [{ saleId: "future", positionId: "f", productId: "2", qty: 1, price: 1 }]);
  const { C, snap, a } = analysed(ds);
  assert.equal(C.quality, "BAD");
  assert.equal(C.norm, null);
  const v = productAnalyticsView(snap, a, null, "20:00");
  assert.ok(v.products.every((r) => !r.today || (r.today.need === 0 && r.today.surplus === 0)));
});

test("clock check: the newest KiT Shop receipt hours old while busy → FAIL with the offset to set", () => {
  const ds = fridgeDataset();
  ds.state.clockProbe = { at: NOW, gapMinutes: 121, receiptsLastHour: 40, offsetMinutes: 0 };
  const { snap } = analysed(ds);
  const c = snap.productDays!.checks[0].find((x) => x.id === "clock")!;
  assert.equal(c.level, "FAIL");
  assert.ok(c.detail.includes("KITSHOP_TIME_OFFSET_MINUTES=120"));
});
