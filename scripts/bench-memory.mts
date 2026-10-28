/**
 * Memory / speed of the old (180 days of KiT Shop rows in memory) vs the new (recent days + the nightly result) layout,
 * on a realistic volume taken from the company's KiT Shop export: ~800 sale lines and ~200 fill-up lines a day over the
 * network, 15 fridges, ~300 dishes, 180 days. Run:
 *   node --expose-gc --import tsx --conditions=react-server scripts/bench-memory.mts
 */
import { KsDataset } from "../src/lib/kitshop-data/dataset";
import { dsHistory } from "../src/lib/kitshop-data/history";
import { runAnalyticsSync, completeness } from "../src/lib/kitshop-data/analytics";
import { buildKitShopSnapshot } from "../src/lib/kitshop-data/snapshot";
import { configuredFridges } from "../src/lib/simulator/model";
import { analyze } from "../src/lib/engine/analysis";
import { computeTomorrow } from "../src/lib/engine/tomorrow";

const DAY = 86_400_000;
const H = 3_600_000;
const TODAY = 20_754;
const NOW = TODAY * DAY + 13 * H;
const gc = (globalThis as { gc?: () => void }).gc!;
const heap = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed / 1_048_576;
};
const ms = (f: () => unknown) => {
  const t = performance.now();
  const r = f();
  return { r, ms: Math.round(performance.now() - t) };
};

const fridges = configuredFridges(TODAY);
const shops = fridges.map((f) => f.externalId);
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

function generate(days: number) {
  const ds = new KsDataset();
  for (const s of shops) ds.shops.set(s, { shopId: s, name: s, stocksAccounting: true });
  for (let p = 1; p <= 300; p++) ds.products.set(String(100000 + p), { productId: String(100000 + p), name: `Блюдо ${p}`, barcode: null, vendorCode: null, price: 1000 + p, groupId: null });
  let sid = 0;
  let fid = 0;
  for (let d = TODAY - days; d <= TODAY; d++) {
    for (const shop of shops) {
      // ~13 dishes a day per fridge, delivered in the morning, sold over the day, the rest unloaded / written off later
      const menu = Array.from({ length: 13 }, () => String(100001 + Math.floor(rnd() * 300)));
      for (const pid of menu) {
        const put = 3 + Math.floor(rnd() * 5);
        const id = String(++fid);
        ds.fillUps.set(id, { fillupId: id, shopId: shop, at: d * DAY + 7 * H, type: 1, notes: null, userName: "k", detailed: true });
        ds.fillUpLines.set(id, [{ fillupId: id, lineId: "0", productId: pid, qty: put }]);
        const sold = Math.max(0, put - Math.floor(rnd() * 3));
        for (let k = 0; k < sold; k++) {
          const at = d * DAY + (8 + Math.floor(rnd() * 10)) * H + Math.floor(rnd() * 60) * 60_000;
          if (at > NOW) continue;
          const s = String(++sid);
          ds.sales.set(s, { saleId: s, shopId: shop, soldAt: at, total: 1000, detailed: true });
          ds.positions.set(s, [{ saleId: s, positionId: s, productId: pid, qty: 1, price: 1000 }]);
        }
        if (put > sold && d < TODAY - 1) {
          const id2 = String(++fid);
          ds.fillUps.set(id2, { fillupId: id2, shopId: shop, at: (d + 2) * DAY + 8 * H, type: rnd() < 0.5 ? 2 : 3, notes: null, userName: "k", detailed: true });
          ds.fillUpLines.set(id2, [{ fillupId: id2, lineId: "0", productId: pid, qty: put - sold }]);
        }
      }
    }
  }
  for (const s of shops) ds.stockAt.set(s, NOW);
  ds.state.backfillFrom = (TODAY - days) * DAY;
  ds.state.fillupsBackfillFrom = (TODAY - days) * DAY;
  ds.state.lastSuccessAt = NOW;
  return ds;
}

const base = heap();
const full = generate(180);
let lines = 0;
for (const l of full.positions.values()) lines += l.length;
const fullRows = full.sales.size + lines + full.fillUps.size;
const heapFull = heap() - base;
console.log(`OLD layout (everything in memory): ${full.sales.size} receipts, ${lines} lines, ${full.fillUps.size} fill-ups = ${fullRows} rows · ${heapFull.toFixed(0)} MB heap`);

// the old every-5-minutes work: the snapshot computed from the whole history
const oldSnap = ms(() => buildKitShopSnapshot(full, fridges, NOW));
console.log(`OLD snapshot (history recomputed every 5 min): ${oldSnap.ms} ms`);

// the nightly job (runs once a day)
const c = completeness(full.state, NOW, null, null);
const job = ms(() => runAnalyticsSync(dsHistory(full), { now: NOW, shopIds: shops, ds: full, ...c }));
const cache = job.r;
for (const s of cache.shops.values()) s.dailyRows = new Map();
console.log(`NEW nightly job (once a day): ${job.ms} ms`);

// NEW layout: only the last KEEP_DAYS days in memory + the nightly result
const slim = new KsDataset();
slim.slim = true;
for (const [k, v] of full.shops) slim.shops.set(k, v);
for (const [k, v] of full.products) slim.products.set(k, v);
for (const [k, v] of full.stockAt) slim.stockAt.set(k, v);
slim.state = full.state;
for (const [id, s] of full.sales) if (s.soldAt >= NOW - KsDataset.KEEP_DAYS * DAY) {
  slim.sales.set(id, s);
  slim.positions.set(id, full.positions.get(id)!);
}
for (const [id, f] of full.fillUps) if (f.at! >= NOW - KsDataset.KEEP_DAYS * DAY) {
  slim.fillUps.set(id, f);
  slim.fillUpLines.set(id, full.fillUpLines.get(id)!);
}
let slimLines = 0;
for (const l of slim.positions.values()) slimLines += l.length;
const slimRows = slim.sales.size + slimLines + slim.fillUps.size;
(full as unknown as { sales: unknown }).sales = null;
(full as unknown as { positions: unknown }).positions = null;
(full as unknown as { fillUps: unknown }).fillUps = null;
(full as unknown as { fillUpLines: unknown }).fillUpLines = null;
const heapSlim = heap() - base;
console.log(`NEW layout (recent days + nightly result): ${slimRows} rows in memory · ${heapSlim.toFixed(0)} MB heap (incl. the nightly result)`);
console.log(`rows NOT loaded into memory any more: ${fullRows - slimRows}`);

const newSnap = ms(() => buildKitShopSnapshot(slim, fridges, NOW, { cache }));
console.log(`NEW snapshot (every 5 min, no history work): ${newSnap.ms} ms`);
const an = ms(() => analyze(newSnap.r, { forecastBias: {}, pairStats: {} }, []));
console.log(`NEW analysis for Analytics / transfers (from the stored norms): ${an.ms} ms`);
const menu = newSnap.r.products.slice(0, 18).map((p) => p.id);
const tm = ms(() => computeTomorrow({ snap: newSnap.r, forecasts: an.r.forecasts, stats: an.r.products, menu, day: TODAY + 1 }));
console.log(`NEW Tomorrow table (18 dishes × ${fridges.length} fridges): ${tm.ms} ms`);
const sample = tm.r.filter((x) => x.qty !== null).slice(0, 3);
console.log("sample cells:", sample.map((x) => `${x.productId}@${x.shopId}: ${x.qty} (норма ${x.base}, утром останется ${x.expectedLeft}, ${x.confidence})`).join(" | "));
