import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulator } from "../src/lib/simulator/simulator";
import { buildContext } from "../src/lib/engine/history";
import { activityProfile, activityWindow, scheduledAt } from "../src/lib/engine/activity";
import { forecastFridge, sumAcross } from "../src/lib/engine/forecast";
import { horizonWindow } from "../src/lib/engine/recommend";
import { aggregateSales } from "../src/services/kitshop/adapter";
import { CATEGORIES } from "../src/lib/domain/categories";
import type { Fridge, Product } from "../src/lib/domain/types";
import { circularLength, dayNumber, inCircularRange, weekdayOf } from "../src/lib/time";

/** Time model: no "09:00–18:00" assumption anywhere — every real sale timestamp counts. */

const FRIDAY = dayNumber(Date.UTC(2026, 9, 2)); // Fri 2 Oct 2026
const at = (day: number, h: number, m = 0) => day * 86_400_000 + (h * 60 + m) * 60_000;
const byName = (snap: { fridges: Fridge[] }, prefix: string) => snap.fridges.findIndex((f) => f.name.startsWith(prefix));

test("sales at 23:30, 01:15, Saturday and Sunday are all counted in the history cube and daily totals", () => {
  const products: Product[] = [{ id: "P1", externalId: "1", name: "Паста", categoryId: "hot", price: 450, sku: "ГР-01", imageUrl: null, barcode: null }];
  const sat = FRIDAY + 1;
  const sun = FRIDAY + 2;
  const cube = aggregateSales(
    [
      { shopId: "S", productId: "1", quantity: 1, soldAt: at(FRIDAY, 23, 30) },
      { shopId: "S", productId: "1", quantity: 2, soldAt: at(sat, 1, 15) },
      { shopId: "S", productId: "1", quantity: 3, soldAt: at(sat, 14, 0) },
      { shopId: "S", productId: "1", quantity: 4, soldAt: at(sun, 3, 5) },
    ],
    new Map([["S", 0]]),
    new Map([["1", 0]]),
    products,
    FRIDAY,
    3,
  );
  const c = CATEGORIES.findIndex((x) => x.id === "hot");
  const cell = (d: number, h: number) => cube.hourly[((0 * CATEGORIES.length + c) * 3 + d) * 24 + h];
  assert.equal(cell(0, 23), 1, "23:30 sale → Friday 23:00 bucket");
  assert.equal(cell(1, 1), 2, "01:15 sale → Saturday (calendar day), 01:00 bucket");
  assert.equal(cell(1, 14), 3, "Saturday sale counted");
  assert.equal(cell(2, 3), 4, "Sunday night sale counted");
  const dayTotal = (d: number) => Array.from({ length: 24 }, (_, h) => cell(d, h)).reduce((a, b) => a + b, 0);
  assert.deepEqual([dayTotal(0), dayTotal(1), dayTotal(2)], [1, 5, 4], "daily totals keep night and weekend sales");
  assert.equal(cube.productDaily[0] + cube.productDaily[1] + cube.productDaily[2], 10);
});

test("REAL TIME at 23:30 forecasts through midnight (23:30–01:00)", () => {
  const w = horizonWindow("realtime", 23 * 60 + 30);
  assert.deepEqual(w, { end: 25 * 60, passed: false });
  const today = new Array(24).fill(0);
  const tomorrow = new Array(24).fill(0);
  today[23] = 6; // 6 per hour at 23:00
  tomorrow[0] = 4; // 4 per hour at 00:00
  assert.equal(sumAcross(today, tomorrow, 23 * 60 + 30, w.end), 3 + 4, "half an hour of today + one hour of tomorrow");
  assert.deepEqual(horizonWindow("h1", 23 * 60 + 30), { end: 24 * 60 + 30, passed: false });
});

test("ДО 20:00 is a user mode: after 20:00 the horizon is reported as passed", () => {
  assert.deepEqual(horizonWindow("until20", 19 * 60, { untilMinute: 1200 }), { end: 1200, passed: false });
  const late = horizonWindow("until20", 21 * 60, { untilMinute: 1200 });
  assert.equal(late.passed, true);
  assert.equal(late.end, 21 * 60 + 90, "falls back to the REAL TIME window, never to a fixed 18:00/20:00");
});

test("an 18:00–02:00 window works across midnight", () => {
  assert.ok(inCircularRange(23 * 60, 18 * 60, 2 * 60));
  assert.ok(inCircularRange(60, 18 * 60, 2 * 60));
  assert.ok(!inCircularRange(3 * 60, 18 * 60, 2 * 60));
  assert.ok(!inCircularRange(12 * 60, 18 * 60, 2 * 60));
  assert.equal(circularLength(18 * 60, 2 * 60), 8 * 60);
  const fr = { workingDays: [5], openingMinute: 18 * 60, closingMinute: 2 * 60 } as unknown as Fridge;
  assert.ok(scheduledAt(fr, 5, 23), "Friday 23:00 open");
  assert.ok(scheduledAt(fr, 6, 1), "Saturday 01:00 belongs to Friday's night");
  assert.ok(!scheduledAt(fr, 6, 3), "Saturday 03:00 closed");
  assert.ok(!scheduledAt(fr, 5, 1), "Friday 01:00 belongs to Thursday — not scheduled");
});

test("observed activity is learned per fridge: night point, 24/7 point, weekend sales, schedule mismatch", () => {
  const sim = Simulator.create(11, FRIDAY, 12 * 60);
  const ctx = buildContext(sim.snapshot());
  const night = activityProfile(ctx, byName(ctx.snap, "95 Жибек"));
  const allDay = activityProfile(ctx, byName(ctx.snap, "92 Каблан 3"));
  const office = activityProfile(ctx, byName(ctx.snap, "1 Шарипова"));
  const weekendPoint = activityProfile(ctx, byName(ctx.snap, "9 Конкорд 2"));

  // weekday × hour profile covers 00–23 and all 7 days
  assert.equal(night.avg.length, 7);
  assert.ok(night.avg.every((row) => row.length === 24));
  assert.ok(night.avg[4][23] > 0 && night.avg[5][1] > 0, "Friday 23:00 and Saturday 01:00 sales are in the profile");
  assert.ok(night.nightShare > 0.3, `night point night share ${night.nightShare}`);
  assert.ok(night.ranges.some((r) => r.from === 16 * 60 && r.to === 26 * 60), "observed 16:00–02:00 across midnight");
  assert.ok(night.mismatches.length > 0, "configured Mon–Fri 08–20 vs real night sales → SCHEDULE MISMATCH");

  assert.ok(allDay.active.every((row) => row.every(Boolean)), "24/7 point is active every hour of every day");
  assert.ok(office.active[5].every((v) => !v) && office.active[6].every((v) => !v), "office point has no weekend activity");
  assert.ok(office.nightShare < 0.01);
  assert.ok(weekendPoint.weekendShare > 0.35, `weekend-heavy point ${weekendPoint.weekendShare}`);
});

test("at 23:30 a night fridge is active and its forecast window crosses midnight", () => {
  const sim = Simulator.create(11, FRIDAY, 23 * 60 + 30);
  const snap = sim.snapshot();
  const ctx = buildContext(snap);
  const f = byName(snap, "95 Жибек");
  const ff = forecastFridge(ctx, f);
  assert.ok(ff.isOpenNow, "active at 23:30 by observed history");
  assert.ok(ff.activityEndMinute > 24 * 60, `activity continues after midnight (end ${ff.activityEndMinute})`);
  const e2 = ff.categories.reduce((a, c) => a + c.expected2h, 0);
  assert.ok(e2 > 0, "demand expected for 23:30–01:30");
  const tomorrowEarly = ff.categories.reduce((a, c) => a + c.tomorrowHourly[0] + c.tomorrowHourly[1], 0);
  assert.ok(tomorrowEarly > 0, "Saturday 00:00–02:00 demand is part of the forecast");
  // the office fridge is not "open" at 23:30 and expects ~nothing
  const office = forecastFridge(ctx, byName(snap, "1 Шарипова"));
  assert.ok(!office.isOpenNow);
  assert.ok(office.categories.reduce((a, c) => a + c.expected2h, 0) < 0.5);
  const w = activityWindow(activityProfile(ctx, f), ctx.today, 23 * 60 + 30);
  assert.ok(w.activeNow && w.end > 1440);
});

test("simulator: night sales land in the calendar day and its revenue; weekday × hour heatmap uses 00–23", () => {
  const sim = Simulator.create(5, FRIDAY + 1, 0); // Saturday 00:00
  sim.advance(3 * 60); // until 03:00
  const snap = sim.snapshot();
  const C = CATEGORIES.length;
  const sold = (f: number) => {
    let s = 0;
    for (let c = 0; c < C; c++) for (let q = 0; q < 12; q++) s += snap.today.quarterSales[(f * C + c) * 96 + q];
    return s;
  };
  const night = byName(snap, "95 Жибек");
  const allDay = byName(snap, "92 Каблан 3");
  assert.ok(sold(night) + sold(allDay) > 0, "Saturday 00:00–03:00 sales exist");
  assert.ok(snap.today.revenue[night] + snap.today.revenue[allDay] > 0, "daily revenue includes night sales");
  assert.equal(sold(byName(snap, "1 Шарипова")), 0, "office point sells nothing at night");
  assert.equal(weekdayOf(snap.today.day), 6);
});
