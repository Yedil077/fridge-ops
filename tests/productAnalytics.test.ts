import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline } from "../src/lib/kitshop-data/stockTimeline";
import { KsDataset } from "../src/lib/kitshop-data/dataset";
import { buildKitShopSnapshot } from "../src/lib/kitshop-data/snapshot";
import { configuredFridges } from "../src/lib/simulator/model";
import { analyze } from "../src/lib/engine/analysis";
import { normOf } from "../src/lib/engine/productNorm";
import { productAnalyticsView } from "../src/lib/server/productAnalyticsView";
import { dayNumber } from "../src/lib/time";

/**
 * PRODUCT × FRIDGE analytics on real-shaped KiT Shop data (receipts, loads / unloads, stock) — never the simulator:
 *  • availability per day from the stock reconstruction and from the 5-minute stock history;
 *  • the norm counts only days when the dish was really there;
 *  • a write-off is only what the unload note says.
 */

const DAY = 86_400_000;
const H = 3_600_000;
const S = 20_000; // a day number
const t = (day: number, h: number, m = 0) => day * DAY + h * H + m * 60_000;

test("timeline: stock reconstructed backwards from sales and loads/unloads → availability, sold-out count, end-of-day stock", () => {
  const sales: { at: number; productId: string; qty: number }[] = [];
  for (let d = 0; d < 3; d++) for (let h = 9; h <= 17; h++) sales.push({ at: t(S + d, h, 30), productId: "B", qty: 1 });
  sales.push({ at: t(S, 10), productId: "A", qty: 1 }, { at: t(S, 11), productId: "A", qty: 1 }, { at: t(S, 12), productId: "A", qty: 1 });
  sales.push({ at: t(S + 1, 10), productId: "A", qty: 1 });
  const fills = [
    { at: t(S, 8), productId: "B", qty: 30 },
    { at: t(S, 9), productId: "A", qty: 3 },
    { at: t(S + 1, 9), productId: "A", qty: 2 },
    { at: t(S + 1, 18), productId: "A", qty: -1 },
  ];
  const r = buildTimeline({
    sales,
    fills,
    history: new Map(),
    coverage: [],
    current: new Map([["B", 3]]),
    currentAt: t(S + 3, 0),
    validFrom: t(S, 0),
    startDay: S,
    days: 3,
  });
  assert.equal(r.fixes, 0, "the movements add up");
  const a = r.dishes.get("A")!;
  // day 1: sold out at 12:00 → the 6 sales of the fridge after that (12:30…17:30) of 12 were made without it
  assert.ok(Math.abs(a.avail[0] - 0.5) < 1e-6, `day 1 availability ${a.avail[0]}`);
  assert.equal(a.ranOut[0], 1, "a sale took the last unit");
  assert.equal(a.eod[0], 0);
  // day 2: there from 9:00 until the unload at 18:00 — no fridge sale happened without it; an unload is not "sold out"
  assert.equal(a.avail[1], 1);
  assert.equal(a.ranOut[1], 0);
  // day 3: never there
  assert.equal(a.avail[2], 0);
  assert.equal(r.dishes.get("B")!.avail[2], 1);
  assert.equal(r.dishes.get("B")!.eod[2], 3);
});

test("timeline: the 5-minute stock history wins inside its periods; before it — reconstruction from its first state", () => {
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
  // history: 2 until 12:00, then 0 → after 12:00 six of the eleven sales of the day were made without it
  assert.ok(Math.abs(a.avail[1] - (1 - 6 / 11)) < 1e-6, `history day availability ${a.avail[1]}`);
  assert.equal(a.ranOut[1], 1, "went to 0 without an unload → sold out");
  // the day before: reconstructed back from the 2 units at the start of the history period
  assert.equal(a.avail[0], 1);
  assert.equal(a.eod[0], 2);
});

test("norm per day: rounded with a small safety, a range, no norm for very slow dishes", () => {
  assert.deepEqual(normOf(2.2), { min: 2, rec: 2, max: 3 });
  assert.deepEqual(normOf(1.4), { min: 1, rec: 2, max: 2 });
  assert.deepEqual(normOf(0.5), { min: 1, rec: 1, max: 1 });
  assert.deepEqual(normOf(0.1), { min: 0, rec: 0, max: 0 });
});

// ───────────── one real-shaped fridge over 40 days ─────────────

const SATTI1 = "621583";
const DAYS = 40;
const TODAY = 20_750; // 2026-10-24
const NOW = t(TODAY, 13);

/**
 * Dish A ("Чизкейк"): loaded 2 on even days only, both sold at 17:00 / 17:10 → on odd days it is simply not there.
 * Dish B ("Цезарь"): loaded 5 every morning, 3 sold, 2 taken out at 20:00 with the note "Списание: истёк срок".
 */
function fridgeDataset() {
  const ds = new KsDataset();
  ds.shops.set(SATTI1, { shopId: SATTI1, name: "SATTI 1", stocksAccounting: true });
  ds.products.set("1", { productId: "1", name: "Чизкейк", barcode: null, vendorCode: null, price: 1500, groupId: null });
  ds.products.set("2", { productId: "2", name: "Салат Цезарь", barcode: null, vendorCode: null, price: 1900, groupId: null });
  let sid = 0;
  let fid = 0;
  const sale = (at: number, pid: string) => {
    const id = String(++sid);
    ds.sales.set(id, { saleId: id, shopId: SATTI1, soldAt: at, total: 1000, detailed: true });
    ds.positions.set(id, [{ saleId: id, positionId: id, productId: pid, qty: 1, price: 1000 }]);
  };
  const fill = (at: number, pid: string, qty: number, notes: string | null = null) => {
    const id = String(++fid);
    ds.fillUps.set(id, { fillupId: id, shopId: SATTI1, at, type: qty > 0 ? 1 : 2, notes, userName: "test", detailed: true });
    ds.fillUpLines.set(id, [{ fillupId: id, lineId: "0", productId: pid, qty }]);
  };
  for (let d = TODAY - DAYS; d <= TODAY; d++) {
    fill(t(d, 8), "2", 5);
    if (d === TODAY) {
      sale(t(d, 9, 30), "2");
      continue;
    }
    sale(t(d, 9, 30), "2");
    sale(t(d, 12, 30), "2");
    sale(t(d, 16, 30), "2");
    fill(t(d, 20), "2", -2, "Списание: истёк срок");
    if (d % 2 === 0) {
      fill(t(d, 8), "1", 2);
      sale(t(d, 17), "1");
      sale(t(d, 17, 10), "1");
    }
  }
  ds.stock.set(SATTI1, new Map([["2", 4]]));
  ds.stockAt.set(SATTI1, NOW);
  ds.state.backfillFrom = t(TODAY - DAYS - 1, 0);
  ds.state.fillupsBackfillFrom = t(TODAY - DAYS - 1, 0);
  ds.state.lastSuccessAt = NOW;
  return ds;
}

function analysed() {
  const fridges = configuredFridges(TODAY).filter((f) => f.externalId === SATTI1);
  const snap = buildKitShopSnapshot(fridgeDataset(), fridges, NOW);
  const a = analyze(snap, { forecastBias: {}, pairStats: {} }, []);
  const p = (name: string) => snap.products.findIndex((x) => x.name.includes(name));
  return { snap, a, A: a.products.at[p("Чизкейк")]!, B: a.products.at[p("Цезарь")]! };
}

test("availability: 'sold little' is not 'low demand' when the dish was missing half the month", () => {
  const { A, snap } = analysed();
  assert.equal(snap.productDays!.reconstructionFixes, 0);
  assert.equal(A.sold.d30, 30, "2 on each of the 15 even days");
  assert.ok(Math.abs(A.avg30 - 1) < 0.05, `plain average ${A.avg30}`);
  assert.ok(Math.abs((A.rate30 ?? 0) - 2) < 0.05, `per day WITH the dish ${A.rate30}`);
  assert.equal(A.daysOut30, 15);
  assert.equal(A.knownDays30, 30);
  assert.ok(A.frequentlyOut);
  assert.equal(A.status, "MORE");
  assert.equal(A.norm.rec, 2, "2/day (+10% for running out) → 2");
  assert.equal(A.confidence, "MEDIUM", "40 days: not yet a confident profile");
});

test("unloads and write-offs: only the note makes an unload a write-off; a lot taken out → put less", () => {
  const { B } = analysed();
  assert.equal(B.loaded30, 150);
  assert.equal(B.removed30, 60);
  assert.equal(B.writtenOff30, 60, "every unload had 'Списание' in its note");
  assert.equal(B.writeOffShare, 0.4);
  assert.equal(B.status, "LESS");
  assert.ok(Math.abs(B.rate - 3) < 0.05, `rate ${B.rate}`);
  assert.equal(B.norm.rec, 3, "3/day −10% = 2.7 → 3");
  assert.equal(B.timesRanOut30, 0, "taken out at night, never sold out");
  assert.equal(B.daysOut30, 0);
});

test("analytics view: every dish of the fridge, today's target = the demand cell the transfers use", () => {
  const { snap, a } = analysed();
  const v = productAnalyticsView(snap, a, null, "20:00");
  assert.equal(v.products.length, 2);
  const P = snap.products.length;
  for (const r of v.products) {
    const cell = a.demand.NOW.products[0 * P + snap.products.findIndex((x) => x.id === r.productId)]!;
    assert.deepEqual([r.today!.target, r.today!.need, r.today!.surplus], [cell.target, cell.need, cell.surplus]);
  }
  assert.equal(v.fridge.summary.sold30, 120);
  assert.equal(v.fridge.summary.writtenOff30, 60);
  assert.equal(v.fridge.summary.deficit, 1);
  assert.equal(v.fridge.summary.surplus, 1);
  assert.ok(v.data.stockKnownFrom, "availability is known from the reconstruction");
});

test("no loads/unloads read → availability unknown, assumed, never invented", () => {
  const ds = fridgeDataset();
  ds.fillUps.clear();
  ds.fillUpLines.clear();
  ds.state.fillupsBackfillFrom = null;
  const fridges = configuredFridges(TODAY).filter((f) => f.externalId === SATTI1);
  const snap = buildKitShopSnapshot(ds, fridges, NOW);
  const a = analyze(snap, { forecastBias: {}, pairStats: {} }, []);
  const A = a.products.at[snap.products.findIndex((x) => x.name.includes("Чизкейк"))]!;
  assert.equal(snap.productDays!.stockKnownFromDay, null);
  assert.equal(A.knownDays30, 0);
  assert.equal(A.daysOut30, 0, "no stock-out is invented");
  assert.equal(A.writtenOff30, 0);
  assert.equal(A.removedShare, null);
  assert.ok(Math.abs((A.rate30 ?? 0) - 1) < 0.05, "without availability the plain average is used");
  assert.equal(dayNumber(NOW), TODAY);
});

test("loads in KiT Shop do not add up with sales (loading goes another way) → no reconstruction, nothing invented", () => {
  const ds = fridgeDataset();
  for (const [id, lines] of ds.fillUpLines) if (lines[0].productId === "2" && lines[0].qty > 0) {
    ds.fillUpLines.delete(id);
    ds.fillUps.delete(id);
  }
  const fridges = configuredFridges(TODAY).filter((f) => f.externalId === SATTI1);
  const snap = buildKitShopSnapshot(ds, fridges, NOW);
  assert.deepEqual(snap.productDays!.unbalanced, [fridges[0].name]);
  assert.equal(snap.productDays!.stockKnownFromDay, null);
  const a = analyze(snap, { forecastBias: {}, pairStats: {} }, []);
  const A = a.products.at[snap.products.findIndex((x) => x.name.includes("Чизкейк"))]!;
  assert.equal(A.knownDays30, 0, "availability is not taken from an impossible reconstruction");
  assert.equal(A.avgEod30, null);
  const v = productAnalyticsView(snap, a, null, "20:00");
  assert.ok(v.data.notes.some((n) => n.includes("не сходятся с продажами")));
});
