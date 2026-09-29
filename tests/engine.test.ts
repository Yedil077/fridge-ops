import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulator } from "../src/lib/simulator/simulator";
import { analyze } from "../src/lib/engine/analysis";
import { dayNumber } from "../src/lib/time";

const learning = () => ({ forecastBias: {}, pairStats: {} });

test("simulator builds 15 fridges with 180 days of history", () => {
  const sim = Simulator.create(7, dayNumber(Date.UTC(2026, 8, 29)));
  const snap = sim.snapshot();
  assert.equal(snap.fridges.length, 15);
  assert.equal(snap.history.days, 180);
  assert.ok(snap.fridges.every((f) => f.name.startsWith("Сатти")));
});

test("recommendations are product-level routes that respect stock", () => {
  const sim = Simulator.create(42, dayNumber(Date.UTC(2026, 8, 29)));
  let checked = 0;
  for (const step of [240, 180, 120]) {
    sim.advance(step);
    const snap = sim.snapshot();
    const r = analyze(snap, learning(), []);
    const P = snap.products.length;
    const fIdx = new Map(snap.fridges.map((f, i) => [f.id, i]));
    const pIdx = new Map(snap.products.map((p, i) => [p.id, i]));
    for (const m of r.drafts) {
      assert.ok(m.stops.length >= 1 && m.stops.length <= 3, "1–3 stops per route");
      assert.ok(m.travelMinutes <= 35, "route stays short");
      const s = fIdx.get(m.sourceFridgeId)!;
      const taken = new Map<number, number>();
      for (const line of m.lines) {
        assert.ok(line.products.length > 0, "every line names concrete dishes");
        const sum = line.products.reduce((a, p) => a + p.qty, 0);
        assert.equal(sum, line.recommendedQty, "dish quantities add up to the line");
        assert.notEqual(line.targetFridgeId, m.sourceFridgeId);
        assert.ok(m.stops.some((st) => st.targetFridgeId === line.targetFridgeId));
        for (const p of line.products) taken.set(pIdx.get(p.productId)!, (taken.get(pIdx.get(p.productId)!) ?? 0) + p.qty);
        checked++;
      }
      for (const [p, q] of taken) assert.ok(q <= snap.stock[s * P + p], "never take more of a dish than the source has");
    }
  }
  assert.ok(checked > 0, "engine produced at least one line");
});

test("analysis is fast enough for an hourly job", () => {
  const sim = Simulator.create(3, dayNumber(Date.UTC(2026, 8, 29)), 12 * 60);
  const t0 = performance.now();
  analyze(sim.snapshot(), learning(), []);
  assert.ok(performance.now() - t0 < 2000);
});
