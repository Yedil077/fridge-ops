import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline } from "../src/lib/kitshop-data/stockTimeline";
import { KsDataset } from "../src/lib/kitshop-data/dataset";
import { buildKitShopSnapshot, fillDirection } from "../src/lib/kitshop-data/snapshot";
import { configuredFridges } from "../src/lib/simulator/model";
import { analyze } from "../src/lib/engine/analysis";
import { quantile } from "../src/lib/engine/productNorm";
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

test("timeline: reconstruction is an ESTIMATE, the 5-minute stock history is a FACT — never mixed", () => {
  const sales: { at: number; productId: string; qty: number }[] = [];
  for (let d = 0; d < 2; d++) for (let h = 9; h <= 17; h++) sales.push({ at: t(S + d, h, 30), productId: "B", qty: 1 });
  sales.push({ at: t(S + 1, 11), productId: "A", qty: 1 }, { at: t(S + 1, 11, 45), productId: "A", qty: 1 });
  const r = buildTimeline({
    sales,
    fills: [],
    history: new Map([
      ["A", [{ at: t(S + 1, 0), qty: 2 }, { at: t(S + 1, 12), qty: 0 }]],
      ["B", [{ at: t(S + 1, 0), qty: 20 }]],
    ]),
    coverage: [[t(S + 1, 0), t(S + 2, 0)]],
    current: new Map([["B", 11]]),
    currentAt: t(S + 2, 0),
    validFrom: t(S, 0),
    startDay: S,
    days: 2,
  });
  const a = r.dishes.get("A")!;
  // day 2 is a FACT: 2 until 12:00, then 0 → six of the eleven sales of the day were made without it
  assert.ok(Math.abs(a.availFact[1] - (1 - 6 / 11)) < 1e-6);
  assert.equal(a.ranOutFact[1], 1, "went to 0 without an unload → sold out");
  // day 1 only reconstructed: an estimate exists, a fact does not
  assert.equal(a.avail[0], 1);
  assert.ok(Number.isNaN(a.availFact[0]), "no fact before the stock history");
  assert.equal(a.ranOutFact[0], 0);
});

test("timeline: reconstruction backwards from sales and loads/unloads (estimate)", () => {
  const sales: { at: number; productId: string; qty: number }[] = [];
  for (let d = 0; d < 3; d++) for (let h = 9; h <= 17; h++) sales.push({ at: t(S + d, h, 30), productId: "B", qty: 1 });
  sales.push({ at: t(S, 10), productId: "A", qty: 1 }, { at: t(S, 11), productId: "A", qty: 1 }, { at: t(S, 12), productId: "A", qty: 1 });
  const r = buildTimeline({
    sales,
    fills: [
      { at: t(S, 8), productId: "B", qty: 30 },
      { at: t(S, 9), productId: "A", qty: 3 },
    ],
    history: new Map(),
    coverage: [],
    current: new Map([["B", 3]]),
    currentAt: t(S + 3, 0),
    validFrom: t(S, 0),
    startDay: S,
    days: 3,
  });
  assert.equal(r.fixes, 0);
  const a = r.dishes.get("A")!;
  assert.ok(Math.abs(a.avail[0] - 0.5) < 1e-6);
  assert.equal(a.ranOut[0], 1);
  assert.equal(a.avail[2], 0);
  assert.ok(a.availFact.every((x) => Number.isNaN(x)), "nothing of it is a fact");
});

test("quantiles are always one of the real whole values", () => {
  assert.equal(quantile([1, 1, 2, 2, 3], 0.25), 1);
  assert.equal(quantile([1, 1, 2, 2, 3], 0.75), 2);
  assert.equal(quantile([1, 1, 2, 2, 3], 0.9), 3);
  assert.equal(quantile([4], 0.5), 4);
});

// ───────────── one real-shaped fridge over 40 days ─────────────

const SATTI1 = "621583";
const DAYS = 40;
const TODAY = 20_750; // 2026-10-24
const NOW = t(TODAY, 13);

/**
 * A «Чизкейк»: loaded 2 on even days only, both sold → on odd days it is simply not there (no stock history: unknown).
 * B «Цезарь»: loaded 5 every morning, 3 sold, at 20:00 one unloaded (type 2, moved) and one written off (type 3).
 * C «Самса»: sold 1 on 5 days only.
 * D «Морс»: stood in the fridge the last 10 days (stock history), bought on 2 of them.
 */
function fridgeDataset() {
  const ds = new KsDataset();
  ds.shops.set(SATTI1, { shopId: SATTI1, name: "5 БЦ Сатти 1 этаж", stocksAccounting: true });
  const names: Record<string, string> = { "1": "Чизкейк", "2": "Салат Цезарь", "3": "Самса с курицей", "4": "Ягодный морс" };
  for (const [id, name] of Object.entries(names)) ds.products.set(id, { productId: id, name, barcode: null, vendorCode: null, price: 1500, groupId: null });
  let sid = 0;
  let fid = 0;
  const sale = (at: number, pid: string) => {
    const id = String(++sid);
    ds.sales.set(id, { saleId: id, shopId: SATTI1, soldAt: at, total: 1000, detailed: true });
    ds.positions.set(id, [{ saleId: id, positionId: id, productId: pid, qty: 1, price: 1000 }]);
  };
  // KiT Shop: quantities of unloads / write-offs come positive, the type says what it is
  const fill = (at: number, pid: string, qty: number, type: 1 | 2 | 3) => {
    const id = String(++fid);
    ds.fillUps.set(id, { fillupId: id, shopId: SATTI1, at, type, notes: null, userName: "test", detailed: true });
    ds.fillUpLines.set(id, [{ fillupId: id, lineId: "0", productId: pid, qty }]);
  };
  for (let d = TODAY - DAYS; d <= TODAY; d++) {
    fill(t(d, 8), "2", 5, 1);
    sale(t(d, 9, 30), "2");
    if (d === TODAY) continue;
    sale(t(d, 12, 30), "2");
    sale(t(d, 16, 30), "2");
    fill(t(d, 20), "2", 1, 2);
    fill(t(d, 20, 5), "2", 1, 3);
    if (d % 2 === 0) {
      fill(t(d, 8), "1", 2, 1);
      sale(t(d, 17), "1");
      sale(t(d, 17, 10), "1");
    }
    if ([TODAY - 3, TODAY - 9, TODAY - 15, TODAY - 21, TODAY - 27].includes(d)) {
      fill(t(d, 8), "3", 1, 1);
      sale(t(d, 11), "3");
    }
  }
  // D: 3 on the shelf when the stock history starts 10 days ago, sold 1 on two days
  const hist = new Map<string, { at: number; qty: number }[]>([["4", [{ at: t(TODAY - 10, 0), qty: 3 }, { at: t(TODAY - 6, 12), qty: 2 }, { at: t(TODAY - 2, 12), qty: 1 }]]]);
  sale(t(TODAY - 6, 11, 50), "4");
  sale(t(TODAY - 2, 11, 50), "4");
  fill(t(TODAY - 40, 8), "4", 3, 1);
  ds.stockHistory.set(SATTI1, hist);
  ds.stockCoverage.set(SATTI1, [[t(TODAY - 10, 0), NOW]]);
  ds.stock.set(SATTI1, new Map([["2", 4], ["4", 1]]));
  ds.stockAt.set(SATTI1, NOW);
  ds.state.backfillFrom = t(TODAY - DAYS - 1, 0);
  ds.state.fillupsBackfillFrom = t(TODAY - DAYS - 1, 0);
  ds.state.lastSuccessAt = NOW;
  return ds;
}

function analysed(ds = fridgeDataset()) {
  const fridges = configuredFridges(TODAY).filter((f) => f.externalId === SATTI1);
  const snap = buildKitShopSnapshot(ds, fridges, NOW);
  const a = analyze(snap, { forecastBias: {}, pairStats: {} }, []);
  const at = (name: string) => a.products.at[snap.products.findIndex((x) => x.name.includes(name))]!;
  return { snap, a, A: at("Чизкейк"), B: at("Цезарь"), C: at("Самса"), Dm: at("морс") };
}

const isWhole = (x: unknown): boolean =>
  typeof x === "number" ? Number.isInteger(x) : Array.isArray(x) ? x.every(isWhole) : x && typeof x === "object" ? Object.values(x).every(isWhole) : true;

test("every quantity a person sees is a whole number of units", () => {
  const { snap, a } = analysed();
  const v = productAnalyticsView(snap, a, null, "20:00");
  for (const r of v.products) {
    for (const k of ["sold", "usual", "norm", "fact", "estimate", "today", "loaded30", "removed30", "writtenOff30", "stock", "salesDays30", "openDays30", "strongDay"] as const)
      assert.ok(isWhole((r as Record<string, unknown>)[k]), `${r.name}.${k} = ${JSON.stringify((r as Record<string, unknown>)[k])}`);
    for (const w of [...r.why, r.recommendation, r.today?.reason ?? ""]) assert.ok(!/\d[.,]\d/.test(w), `no fractions in «${w}»`);
  }
  assert.ok(isWhole(v.fridge.summary));
});

test("days without the dish are not 'zero demand': without the stock history only days with sales count", () => {
  const { A } = analysed();
  assert.equal(A.sold.d30, 30);
  assert.equal(A.salesDays30, 15);
  assert.equal(A.basis, "SALES_DAYS", "stock history does not cover these days");
  assert.deepEqual(A.usual, { low: 2, high: 2 });
  assert.deepEqual(A.norm, { min: 2, rec: 2, max: 2 });
  assert.equal(A.recommendation, "Ставить 2 шт.");
  assert.equal(A.quality, "INCOMPLETE");
  assert.notEqual(A.confidence, "HIGH");
  assert.ok(A.estimate && A.estimate.out >= 9, "the estimate (days without stock history) sees the odd days without it — shown apart, not in the norm");
});

test("unload ≠ write-off; losses lower the norm to the usual day", () => {
  const { B } = analysed();
  assert.equal(B.loaded30, 150);
  assert.equal(B.removed30, 30, "type 2 «Разгрузка» → снято");
  assert.equal(B.writtenOff30, 30, "type 3 «Списание» → подтверждённое списание");
  assert.equal(B.status, "LESS");
  assert.deepEqual(B.norm, { min: 3, rec: 3, max: 3 });
  assert.ok(B.why.some((w) => w.includes("снято 30 шт.") && w.includes("списано 30 шт.")));
});

test("rare demand: 1 unit when presence is unknown; 'не держать ежедневно' only when the stock history confirms it stood there", () => {
  const { C, Dm } = analysed();
  assert.equal(C.status, "RARE");
  assert.equal(C.salesDays30, 5);
  assert.equal(C.recommendation, "Ставить 1 шт.");
  assert.equal(Dm.status, "RARE");
  assert.equal(Dm.fact.inStock, 10);
  assert.equal(Dm.recommendation, "Не держать ежедневно — низкий спрос");
  assert.equal(Dm.norm!.rec, 0);
});

test("analytics view: today's target is the demand cell the transfers use; data checks are shown", () => {
  const { snap, a } = analysed();
  const v = productAnalyticsView(snap, a, null, "20:00");
  for (const r of v.products) {
    const cell = a.demand.NOW.products[snap.products.findIndex((x) => x.id === r.productId)]!;
    assert.deepEqual([r.today!.target, r.today!.need, r.today!.surplus], [cell.target, cell.need, cell.surplus]);
  }
  assert.equal(v.fridge.summary.writtenOff30, 30);
  const ids = v.fridge.checks.map((c) => c.id);
  for (const id of ["sales", "ids-shop", "ids-product", "integer", "duplicates", "stock", "timezone", "clock", "fresh", "fillups", "unload-writeoff", "balance", "stock-history"])
    assert.ok(ids.includes(id), `check ${id}`);
  assert.equal(v.fridge.checks.find((c) => c.id === "ids-shop")!.level, "OK");
});

test("a failed check (receipts from the future = wrong timezone) → data BAD, no confident norm", () => {
  const ds = fridgeDataset();
  ds.sales.set("future", { saleId: "future", shopId: SATTI1, soldAt: NOW + 2 * H, total: 1, detailed: true });
  ds.positions.set("future", [{ saleId: "future", positionId: "f", productId: "2", qty: 1, price: 1 }]);
  const { B, snap } = analysed(ds);
  assert.equal(snap.productDays!.checks[0].find((c) => c.id === "timezone")!.level, "FAIL");
  assert.equal(B.quality, "BAD");
  assert.equal(B.confidence, "LOW");
});

test("clock check: the newest KiT Shop receipt hours old while busy → FAIL with the offset to set", () => {
  const ds = fridgeDataset();
  ds.state.clockProbe = { at: NOW, gapMinutes: 121, receiptsLastHour: 40, offsetMinutes: 0 };
  const { snap } = analysed(ds);
  const c = snap.productDays!.checks[0].find((x) => x.id === "clock")!;
  assert.equal(c.level, "FAIL");
  assert.ok(c.detail.includes("KITSHOP_TIME_OFFSET_MINUTES=120"));
});

test("loads in KiT Shop do not add up with sales → no estimate, nothing invented", () => {
  const ds = fridgeDataset();
  for (const [id, lines] of ds.fillUpLines) if (lines[0].productId === "2" && ds.fillUps.get(id)!.type === 1) {
    ds.fillUpLines.delete(id);
    ds.fillUps.delete(id);
  }
  const { snap, A } = analysed(ds);
  assert.deepEqual(snap.productDays!.unbalanced, ["5 БЦ Сатти 1 этаж"]);
  assert.equal(A.estimate, null);
  assert.equal(snap.productDays!.checks[0].find((c) => c.id === "balance")!.level, "WARN");
});
