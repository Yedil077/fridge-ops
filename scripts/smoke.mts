// Engine smoke test: builds a simulator, runs analysis a few times through the day, prints missions.
// Run: npm run smoke
import { Simulator } from "../src/lib/simulator/simulator";
import { analyze } from "../src/lib/engine/analysis";
import { dayNumber } from "../src/lib/time";

const t0 = Date.now();
const sim = Simulator.create(42, dayNumber(Date.UTC(2026, 8, 29)));
console.log("create ms", Date.now() - t0);
for (const step of [0, 120, 180, 120, 180]) {
  sim.advance(step);
  const snap = sim.snapshot();
  const t1 = Date.now();
  const r = analyze(snap, { forecastBias: {}, pairStats: {} }, []);
  const d = new Date(snap.now);
  console.log(`\n=== ${d.toISOString().slice(0, 16)}  analysis ${Date.now() - t1}ms  open=${r.forecasts.filter((f) => f.isOpenNow).length}`);
  const st = r.forecasts.map((f) => f.status[0]).join("");
  console.log("status", st, "sales", r.forecasts.reduce((a, f) => a + f.salesToday, 0));
  for (const m of r.drafts) {
    console.log(`${m.title} [${m.urgency}] P${m.priority} ${m.sourceFridgeId} → ${m.stops.map((s) => s.targetFridgeId).join(" → ")} | ${m.headline}`);
    for (const l of m.lines) console.log(`    → ${l.targetFridgeId}: ${l.products.map((p) => `${p.name} ×${p.qty} (aff ${p.targetAffinity})`).join(", ")}`);
  }
}
const f = sim.snapshot();
const r = analyze(f, { forecastBias: {}, pairStats: {} }, []);
const c = r.forecasts[0].categories[1];
console.log("\nF01 hot", { stock: c.stock, e1: c.expected1h.toFixed(1), e2: c.expected2h.toFixed(1), close: c.expectedUntilClose.toFixed(1), pace: c.pace.toFixed(2), conf: c.confidence.toFixed(2), base: c.baseline.label, state: c.state });
const cold = r.forecasts[14].categories[1];
console.log("F15 hot", { conf: cold.confidence.toFixed(2), base: cold.baseline.label, net: cold.baseline.networkWeight.toFixed(2) });
if (r.drafts[0]) console.log(JSON.stringify(r.drafts[0].lines[0].why, null, 1), r.drafts[0].effect);
