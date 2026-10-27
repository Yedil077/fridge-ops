import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulator } from "../src/lib/simulator/simulator";
import { analyze, type AnalysisResult } from "../src/lib/engine/analysis";
import { buildProfiles } from "../src/lib/engine/fridgeProfile";
import { demandGrid } from "../src/lib/engine/demand";
import { KsDataset } from "../src/lib/kitshop-data/dataset";
import { buildKitShopSnapshot } from "../src/lib/kitshop-data/snapshot";
import { configuredFridges } from "../src/lib/simulator/model";
import { dayNumber } from "../src/lib/time";
import type { NetworkSnapshot } from "../src/lib/domain/types";

/**
 * ONE SOURCE OF TRUTH: the fridge profile and the transfer recommendations read the same demand cells.
 *  • profile need == need of the task's target, profile can-give == surplus of the task's source;
 *  • no need (profile "норма") → no task for that target;
 *  • the same horizon gives the same numbers everywhere.
 */

const learning = () => ({ forecastBias: {}, pairStats: {} });

function checkConsistency(snap: NetworkSnapshot, a: AnalysisResult) {
  const profiles = buildProfiles(a.ctx, a.forecasts, a.demandIndex, { demand: a.demand });
  const fIdx = new Map(snap.fridges.map((f, i) => [f.id, i]));
  const cIdx = new Map(snap.categories.map((c, i) => [c.id, i]));
  let lines = 0;
  for (const m of a.drafts) {
    const s = fIdx.get(m.sourceFridgeId)!;
    for (const line of m.lines) {
      lines++;
      const t = fIdx.get(line.targetFridgeId)!;
      const c = cIdx.get(line.categoryId)!;
      const tgtCell = a.demand.NOW[t][c];
      const srcCell = a.demand.NOW[s][c];
      // the task's numbers ARE the demand module's numbers
      assert.equal(line.expectedShortage, tgtCell.need, "task target need == demand need");
      assert.equal(line.expectedSurplus, srcCell.surplus, "task source surplus == demand surplus");
      // …and the profile shows the same
      assert.equal(profiles[t].categories[c].need, line.expectedShortage, "profile need == task need");
      assert.equal(profiles[s].categories[c].canGive, line.expectedSurplus, "profile can-give == task surplus");
      // no need → no task; no surplus → no source
      assert.ok(tgtCell.need > 0, "a task exists only where the target needs");
      assert.ok(srcCell.surplus > 0, "a source must have a safe surplus");
      assert.notEqual(profiles[t].categories[c].status, "OK", "a NORMAL category never gets a task");
      assert.ok(line.recommendedQty <= tgtCell.need && line.recommendedQty <= srcCell.surplus, "never more than needed / safely available");
    }
  }
  return lines;
}

test("simulator, several moments of the day: profile and tasks agree on every number", () => {
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
    for (const line of m.lines) assert.equal(line.expectedShortage, a.demand.UNTIL_EVENING[fIdx.get(line.targetFridgeId)!][cIdx.get(line.categoryId)!].need);
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

test("KiT Shop snapshot (production path): profile and tasks agree", () => {
  const snap = buildKitShopSnapshot(kitshopDataset(), satti(), NOW);
  assert.equal(snap.source, "kitshop");
  const a = analyze(snap, learning(), []);
  assert.ok(checkConsistency(snap, a) > 0, "the KiT Shop scenario produced a task (SATTI 1 → SATTI 2 hot food)");
  const profiles = buildProfiles(a.ctx, a.forecasts, a.demandIndex, { demand: a.demand });
  const s2 = snap.fridges.findIndex((f) => f.externalId === "621826");
  const hot = snap.categories.findIndex((c) => c.id === "hot");
  assert.ok(profiles[s2].categories[hot].need > 0, "SATTI 2 with 1 hot dish at lunch needs hot food");
});

test("incomplete history (receipts still without lines) → those days are left out and confidence is lower", () => {
  const full = buildKitShopSnapshot(kitshopDataset(), satti(), NOW);
  const partial = buildKitShopSnapshot(kitshopDataset({ undetailedDaysAgo: 5 }), satti(), NOW);
  assert.ok((partial.historyFromDay ?? 0) > (full.historyFromDay ?? 0), "complete history starts after the incomplete day");
  assert.equal(partial.historyFromDay, dayNumber(NOW) - 4);
  const conf = (snap: NetworkSnapshot) => {
    const a = analyze(snap, learning(), []);
    return buildProfiles(a.ctx, a.forecasts, a.demandIndex, { demand: a.demand }).map((p) => p.confidence);
  };
  const cf = conf(full);
  const cp = conf(partial);
  cp.forEach((v, i) => assert.ok(v < cf[i], `confidence drops while history is incomplete (${v} < ${cf[i]})`));
  assert.ok(cp.every((v) => v <= 0.5), "a few days of complete history never look like a confident profile");
});
