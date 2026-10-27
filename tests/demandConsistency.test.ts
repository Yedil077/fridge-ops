import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulator } from "../src/lib/simulator/simulator";
import { analyze, type AnalysisResult } from "../src/lib/engine/analysis";
import { demandGrid } from "../src/lib/engine/demand";
import { KsDataset } from "../src/lib/kitshop-data/dataset";
import { buildKitShopSnapshot } from "../src/lib/kitshop-data/snapshot";
import { configuredFridges } from "../src/lib/simulator/model";
import { productAnalyticsView } from "../src/lib/server/productAnalyticsView";
import { dayNumber } from "../src/lib/time";
import type { NetworkSnapshot } from "../src/lib/domain/types";

/**
 * ONE SOURCE OF TRUTH: the product analytics (norm per dish per fridge) → engine/demand.ts → transfer recommendations.
 *  • a category need / surplus in a task == the sum of the dish cells == what the analytics screen shows;
 *  • every dish in a task: qty ≤ need of THAT dish at the target and ≤ surplus of THAT dish at the source;
 *  • no need → no task, no surplus → no source; the same horizon gives the same numbers everywhere.
 */

const learning = () => ({ forecastBias: {}, pairStats: {} });

function checkConsistency(snap: NetworkSnapshot, a: AnalysisResult, horizon: "NOW" | "UNTIL_EVENING" = "NOW") {
  const grid = a.demand[horizon];
  const P = snap.products.length;
  const fIdx = new Map(snap.fridges.map((f, i) => [f.id, i]));
  const cIdx = new Map(snap.categories.map((c, i) => [c.id, i]));
  const pIdx = new Map(snap.products.map((p, i) => [p.id, i]));
  let lines = 0;
  for (const m of a.drafts) {
    const s = fIdx.get(m.sourceFridgeId)!;
    for (const line of m.lines) {
      lines++;
      const t = fIdx.get(line.targetFridgeId)!;
      const c = cIdx.get(line.categoryId)!;
      const tgtCell = grid.cells[t][c];
      const srcCell = grid.cells[s][c];
      assert.equal(line.expectedShortage, tgtCell.need, "task target need == demand need");
      assert.equal(line.expectedSurplus, srcCell.surplus, "task source surplus == demand surplus");
      const dishes = (f: number) => snap.products.map((p, i) => (p.categoryId === line.categoryId ? grid.products[f * P + i] : undefined)).filter((x) => !!x);
      assert.equal(tgtCell.need, dishes(t).reduce((acc, x) => acc + x!.need, 0), "a category need is the sum of its dishes");
      assert.equal(srcCell.surplus, dishes(s).reduce((acc, x) => acc + x!.surplus, 0), "a category surplus is the sum of its dishes");
      assert.ok(tgtCell.need > 0 && srcCell.surplus > 0, "no need → no task, no surplus → no source");
      for (const pr of line.products) {
        const p = pIdx.get(pr.productId)!;
        const tc = grid.products[t * P + p]!;
        const sc = grid.products[s * P + p]!;
        assert.ok(pr.qty <= tc.need, `${pr.name}: ${pr.qty} ≤ need ${tc.need} of THAT dish`);
        assert.ok(pr.qty <= sc.surplus, `${pr.name}: ${pr.qty} ≤ surplus ${sc.surplus} of THAT dish`);
      }
      // the analytics screen shows the same cells
      if (horizon === "NOW") {
        const v = productAnalyticsView(snap, a, snap.fridges[t].id, "20:00");
        for (const pr of line.products) {
          const row = v.products.find((r) => r.productId === pr.productId)!;
          assert.equal(row.today!.need, grid.products[t * P + pIdx.get(pr.productId)!]!.need, "analytics «добавить» == task need");
        }
      }
    }
  }
  return lines;
}

test("simulator, several moments of the day: analytics and tasks agree on every number", () => {
  const sim = Simulator.create(42, dayNumber(Date.UTC(2026, 8, 29)));
  let lines = 0;
  for (const step of [240, 120, 120, 120, 120]) {
    sim.advance(step);
    const snap = sim.snapshot();
    lines += checkConsistency(snap, analyze(snap, learning(), []));
  }
  assert.ok(lines > 0, "the scenario produced tasks to check");
});

test("ДО ВЕЧЕРА horizon: the evening task list uses the UNTIL_EVENING cells", () => {
  const sim = Simulator.create(5, dayNumber(Date.UTC(2026, 8, 30)));
  sim.advance(300);
  const snap = sim.snapshot();
  const a = analyze(snap, learning(), [], "until20", 20 * 60);
  const fIdx = new Map(snap.fridges.map((f, i) => [f.id, i]));
  const cIdx = new Map(snap.categories.map((c, i) => [c.id, i]));
  for (const m of a.drafts)
    for (const line of m.lines) assert.equal(line.expectedShortage, a.demand.UNTIL_EVENING.cells[fIdx.get(line.targetFridgeId)!][cIdx.get(line.categoryId)!].need);
  checkConsistency(snap, a, "UNTIL_EVENING");
});

test("same horizon → the same numbers on every call (no screen computes its own)", () => {
  const sim = Simulator.create(9, dayNumber(Date.UTC(2026, 9, 1)));
  sim.advance(360);
  const snap = sim.snapshot();
  const a = analyze(snap, learning(), []);
  const again = demandGrid(a.ctx, a.forecasts, { horizon: "NOW", untilMinute: a.untilMinute, promised: [] });
  assert.deepEqual(again, a.demand.NOW);
});

// ───────────── production path: snapshot built from KiT Shop receipts (not the simulator) ─────────────

const NOW = Date.UTC(2026, 9, 27, 13, 0, 0); // wall clock, Almaty
const DAY = 86_400_000;
const SATTI = ["621583", "621826", "621586"];

function kitshopDataset(opts: { undetailedDaysAgo?: number } = {}) {
  const ds = new KsDataset();
  for (const id of SATTI) ds.shops.set(id, { shopId: id, name: id, stocksAccounting: true });
  const products = [
    { id: "1", name: "Паста с говядиной", price: 2500 },
    { id: "2", name: "Праздничный плов", price: 2200 },
    { id: "3", name: "Салат Цезарь", price: 1900 },
    { id: "4", name: "Ягодный морс 500мл", price: 700 },
  ];
  for (const p of products) ds.products.set(p.id, { productId: p.id, name: p.name, barcode: null, vendorCode: null, price: p.price, groupId: null });
  let id = 0;
  // 60 days, weekdays only, lunch peak; SATTI 2 (621826) sells much more hot food
  for (let d = 60; d >= 0; d--) {
    const dayStart = Math.floor((NOW - d * DAY) / DAY) * DAY;
    const wd = new Date(dayStart).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    SATTI.forEach((shop, si) => {
      const perHour = si === 1 ? 6 : 3;
      for (let h = 9; h < 18; h++) {
        const at0 = dayStart + h * 3_600_000;
        if (at0 > NOW) continue;
        for (let k = 0; k < perHour; k++) {
          const at = at0 + k * 5 * 60_000;
          if (at > NOW) continue;
          const saleId = String(++id);
          const pid = si === 1 ? (k % 3 === 0 ? "3" : "1") : products[(k + h) % 4].id;
          const detailed = !(opts.undetailedDaysAgo !== undefined && d === opts.undetailedDaysAgo && k === 0);
          ds.sales.set(saleId, { saleId, shopId: shop, soldAt: at, total: 2000, detailed });
          if (detailed) ds.positions.set(saleId, [{ saleId, positionId: saleId, productId: pid, qty: 1, price: 2000 }]);
        }
      }
    });
  }
  // current stock: SATTI 2 almost out of hot food, SATTI 1 has plenty
  ds.stock.set("621583", new Map([["1", 9], ["2", 8], ["3", 3], ["4", 6]]));
  ds.stock.set("621826", new Map([["1", 1], ["3", 1]]));
  ds.stock.set("621586", new Map([["1", 4], ["2", 4], ["3", 2], ["4", 3]]));
  ds.state.backfillFrom = NOW - 61 * DAY;
  return ds;
}

function satti() {
  return configuredFridges(dayNumber(NOW)).filter((f) => SATTI.includes(f.externalId));
}

test("KiT Shop snapshot (production path): analytics and tasks agree", () => {
  const snap = buildKitShopSnapshot(kitshopDataset(), satti(), NOW);
  assert.equal(snap.source, "kitshop");
  const a = analyze(snap, learning(), []);
  assert.ok(checkConsistency(snap, a) > 0, "the KiT Shop scenario produced a task (SATTI 1 → SATTI 2 hot food)");
  const s2 = snap.fridges.findIndex((f) => f.externalId === "621826");
  const pasta = snap.products.findIndex((p) => p.name.startsWith("Паста"));
  assert.ok(a.demand.NOW.products[s2 * snap.products.length + pasta]!.need > 0, "SATTI 2 with 1 pasta at lunch needs pasta");
  const plov = snap.products.findIndex((p) => p.name.includes("плов"));
  assert.equal(a.demand.NOW.products[s2 * snap.products.length + plov], undefined, "a dish SATTI 2 never sells gets no need there");
});

test("incomplete history (receipts still without lines) → those days are left out and confidence is low", () => {
  const full = buildKitShopSnapshot(kitshopDataset(), satti(), NOW);
  const partial = buildKitShopSnapshot(kitshopDataset({ undetailedDaysAgo: 5 }), satti(), NOW);
  assert.ok((partial.historyFromDay ?? 0) > (full.historyFromDay ?? 0), "complete history starts after the incomplete day");
  assert.equal(partial.historyFromDay, dayNumber(NOW) - 4);
  const conf = (snap: NetworkSnapshot) => analyze(snap, learning(), []).products.byFridge.flat();
  assert.ok(conf(full).some((x) => x.confidence !== "LOW"), "60 days of history: not everything is low");
  assert.ok(conf(partial).every((x) => x.confidence === "LOW" && x.status === "NO_DATA"), "4 days of complete history never look like a norm");
});
