import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulator } from "../src/lib/simulator/simulator";
import { analyze } from "../src/lib/engine/analysis";
import { buildProfiles, productAffinityByFridge, weightedQuantile } from "../src/lib/engine/fridgeProfile";
import { ENGINE_CONFIG } from "../src/lib/config/engine";
import { dayNumber } from "../src/lib/time";

const learning = () => ({ forecastBias: {}, pairStats: {} });

function setup(advanceMinutes = 300) {
  const sim = Simulator.create(11, dayNumber(Date.UTC(2026, 9, 6))); // a Tuesday
  sim.advance(advanceMinutes);
  const snap = sim.snapshot();
  const a = analyze(snap, learning(), []);
  return { snap, a, profiles: buildProfiles(a.ctx, a.forecasts, a.demandIndex, { demand: a.demand }) };
}

test("weighted quantile: recent days weigh more", () => {
  assert.equal(weightedQuantile([{ v: 10, w: 1 }, { v: 50, w: 1 }, { v: 30, w: 1 }], 0.5), 30);
  assert.equal(weightedQuantile([{ v: 10, w: 0.1 }, { v: 50, w: 0.9 }], 0.5), 50);
  assert.equal(weightedQuantile([], 0.5), 0);
});

test("every fridge gets its OWN norm: ranges are ordered and differ between points", () => {
  const { profiles } = setup();
  assert.equal(profiles.length, 15);
  for (const p of profiles) {
    assert.ok(p.normalDay.low <= p.normalDay.high, "day range ordered");
    assert.ok(p.normalByNow.low <= p.normalByNow.high, "by-now range ordered");
    assert.ok(p.confidence >= 0.3 && p.confidence <= 0.98);
    assert.ok(["NORMAL", "ABOVE", "BELOW", "ANOMALY", "QUIET", "NO_DATA"].includes(p.today.status));
  }
  const avgs = new Set(profiles.map((p) => p.normalDay.avg));
  assert.ok(avgs.size >= 8, "norms are individual, not one number for all");
});

test("weekday index: 1.00 = average of selling weekdays; strong/weak days follow it", () => {
  const { profiles } = setup();
  for (const p of profiles) {
    const selling = p.weekdayIndex.filter((v) => v > 0);
    if (!selling.length) continue;
    const mean = selling.reduce((a, b) => a + b, 0) / selling.length;
    assert.ok(Math.abs(mean - 1) < 0.08, `mean index ≈ 1 (${mean})`);
    for (const d of p.strongWeekdays) assert.ok(p.weekdayIndex[d] >= 1.12);
    assert.ok(p.strongWeekdays.length <= 2 && p.weakWeekdays.length <= 2);
    for (const d of p.weakWeekdays) assert.ok(p.weekdayIndex[d] <= 0.85);
  }
});

test("category affinity drives tags and demand level", () => {
  const { profiles } = setup();
  for (const p of profiles) {
    for (const c of p.categories) {
      assert.equal(c.demand, c.index >= 1.15 ? "HIGH" : c.index <= 0.85 ? "LOW" : "NORMAL");
      if (c.index >= 1.25) assert.ok(p.tags.some((t) => t.emoji === c.emoji), `tag for strong ${c.id}`);
    }
  }
});

test("profile need / can give are exactly the demand module's numbers (NOW)", () => {
  const { profiles, a } = setup();
  for (const p of profiles)
    for (const [c, cp] of p.categories.entries()) {
      const cell = a.demand.NOW[p.fridgeIndex][c];
      assert.equal(cp.need, cell.need);
      assert.equal(cp.canGive, cell.surplus);
      assert.ok(!(cp.need > 0 && cp.canGive > 0), "never needs and gives the same category");
      assert.equal(cp.untilEvening, a.demand.UNTIL_EVENING[p.fridgeIndex][c].expected);
    }
});

test("a day far above the norm is an ANOMALY and does not move the norm", () => {
  const { snap, a, profiles } = setup(420);
  const f = profiles.findIndex((p) => p.normalByNow.avg >= ENGINE_CONFIG.anomaly.minExpectedSoFar);
  assert.ok(f >= 0, "a fridge with enough sales by now");
  const before = profiles[f].normalDay;
  // today's sales ×3 at that fridge
  const C = snap.categories.length;
  for (let i = f * C * 96; i < (f + 1) * C * 96; i++) snap.today.quarterSales[i] *= 3;
  const a2 = analyze(snap, learning(), []);
  const p2 = buildProfiles(a2.ctx, a2.forecasts, a2.demandIndex, { demand: a2.demand })[f];
  assert.equal(p2.today.status, "ANOMALY");
  assert.deepEqual(p2.normalDay, before, "history-based norm unchanged by today");
  assert.ok(p2.summary[0].includes("аномалия"));
  assert.ok(a.forecasts.length === a2.forecasts.length);
});

test("dish affinity: best place for a dish inside a group", () => {
  const { a, snap } = setup();
  const group = snap.fridges.map((f, i) => (f.transferGroup === "SATTI" ? i : -1)).filter((i) => i >= 0);
  const rows = productAffinityByFridge(a.ctx, group, 5);
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(r.affinity.length, group.length);
    const bestIdx = group.indexOf(r.best);
    assert.equal(r.affinity[bestIdx], Math.max(...r.affinity));
  }
});
