// Engine smoke test: simulated day, both forecast modes, prints routes with dishes.
// Run: npm run smoke
import { Simulator } from "../src/lib/simulator/simulator";
import { analyze } from "../src/lib/engine/analysis";
import { dayNumber } from "../src/lib/time";

const sim = Simulator.create(42, dayNumber(Date.UTC(2026, 8, 29)));
const learning = { forecastBias: {}, pairStats: {} };
for (const step of [120, 180, 180, 120]) {
  sim.advance(step);
  const snap = sim.snapshot();
  const group = new Map(snap.fridges.map((f) => [f.id, f.transferGroup]));
  const name = new Map(snap.fridges.map((f) => [f.id, f.name]));
  const t = new Date(snap.now).toISOString().slice(11, 16);
  for (const mode of ["realtime", "until20"] as const) {
    const r = analyze(snap, learning, [], mode);
    const total = r.drafts.reduce((a, m) => a + m.lines.reduce((x, l) => x + l.recommendedQty, 0), 0);
    console.log(`\n=== ${t} · ${mode} · ${r.drafts.length} routes · ${total} items`);
    for (const m of r.drafts) {
      const cross = m.stops.some((s) => group.get(s.targetFridgeId) !== group.get(m.sourceFridgeId));
      console.log(`${m.title} [${m.urgency}] ${name.get(m.sourceFridgeId)} → ${m.stops.map((s) => name.get(s.targetFridgeId)).join(" → ")}${cross ? "  !!! CROSS-GROUP" : ""}`);
      for (const l of m.lines) console.log(`    → ${name.get(l.targetFridgeId)}: ${l.products.map((p) => `${p.name} ×${p.qty}`).join(", ")}`);
    }
  }
}
