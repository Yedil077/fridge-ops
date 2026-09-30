import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulator } from "../src/lib/simulator/simulator";
import { analyze } from "../src/lib/engine/analysis";
import { horizonEnd } from "../src/lib/engine/recommend";
import { ENGINE_CONFIG } from "../src/lib/config/engine";
import { dayNumber } from "../src/lib/time";

const learning = () => ({ forecastBias: {}, pairStats: {} });
const K = ENGINE_CONFIG.conservative;

function daySnapshots() {
  const sim = Simulator.create(42, dayNumber(Date.UTC(2026, 8, 29)));
  const out = [];
  for (const step of [150, 180, 180, 120]) {
    sim.advance(step);
    out.push(sim.snapshot());
  }
  return out;
}

test("food never moves between transfer groups (SATTI ↛ KABLAN_KANKORD …)", () => {
  let checked = 0;
  for (const snap of daySnapshots()) {
    const group = new Map(snap.fridges.map((f) => [f.id, f.transferGroup]));
    for (const mode of ["realtime", "until20"] as const) {
      for (const m of analyze(snap, learning(), [], mode).drafts) {
        for (const l of m.lines) {
          assert.equal(group.get(l.targetFridgeId), group.get(m.sourceFridgeId), `${m.sourceFridgeId} → ${l.targetFridgeId}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 0);
});

test("conservative quantities: per-dish and per-route caps, variety kept at the source", () => {
  for (const snap of daySnapshots()) {
    const P = snap.products.length;
    const fIdx = new Map(snap.fridges.map((f, i) => [f.id, i]));
    const pIdx = new Map(snap.products.map((p, i) => [p.id, i]));
    for (const m of analyze(snap, learning(), [], "realtime").drafts) {
      const items = m.lines.reduce((a, l) => a + l.recommendedQty, 0);
      assert.ok(items <= K.maxItemsPerRoute, `route has ${items} items`);
      const s = fIdx.get(m.sourceFridgeId)!;
      const takenPerDish = new Map<number, number>();
      for (const l of m.lines) {
        assert.ok(l.recommendedQty <= K.maxPerCategoryCritical, "category cap");
        for (const p of l.products) {
          assert.ok(p.qty <= K.maxPerProductCritical, "dish cap");
          const pi = pIdx.get(p.productId)!;
          takenPerDish.set(pi, (takenPerDish.get(pi) ?? 0) + p.qty);
        }
      }
      for (const [pi, q] of takenPerDish) {
        assert.ok(snap.stock[s * P + pi] - q >= 1, "never take the last unit of a dish from the source");
      }
    }
  }
});

test("forecast mode really changes the horizon and the recommendations", () => {
  // 10:00, fridge 08:00–21:00 → REAL TIME ends 11:30, second mode ends at the fridge's closing time 21:00
  assert.equal(horizonEnd("realtime", 480, 1260, 600), 690);
  assert.equal(horizonEnd("until20", 480, 1260, 600), 1260);
  // closing time comes from settings: a fridge closing at 19:00 is forecast until 19:00
  assert.equal(horizonEnd("until20", 480, 1140, 600), 1140);
  const snap = daySnapshots()[0];
  const rt = analyze(snap, learning(), [], "realtime").drafts;
  const u20 = analyze(snap, learning(), [], "until20").drafts;
  assert.ok(rt.every((m) => m.mode === "realtime") && u20.every((m) => m.mode === "until20"));
  const sig = (d: typeof rt) => JSON.stringify(d.map((m) => [m.sourceFridgeId, m.lines.map((l) => [l.targetFridgeId, l.recommendedQty])]));
  assert.notEqual(sig(rt), sig(u20));
});

test("low acceptance at a source makes recommendations smaller", () => {
  const snap = daySnapshots()[1];
  const base = analyze(snap, learning(), [], "until20").drafts;
  const total = (d: typeof base) => d.reduce((a, m) => a + m.lines.reduce((x, l) => x + l.recommendedQty, 0), 0);
  const acceptance = Object.fromEntries(snap.fridges.map((f) => [f.id, { ratio: 0.3, n: 10 }]));
  const cautious = analyze(snap, { ...learning(), acceptance }, [], "until20").drafts;
  assert.ok(total(cautious) < total(base), `${total(cautious)} < ${total(base)}`);
});
