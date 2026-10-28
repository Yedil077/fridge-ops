import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseBatches } from "../src/lib/engine/batches";
import type { ProductEvents } from "../src/lib/domain/types";

/**
 * Delivery batches: loaded → sold within the shelf life (FIFO, the oldest units first) → unloaded / written off / left.
 * Movements are KiT Shop facts: 0 sale, 1 load, 2 unload («снято»), 3 write-off.
 */

const H = 3_600_000;
const DAY = 24 * H;
const T0 = 20_700 * DAY;
const at = (d: number, h: number) => T0 + d * DAY + h * H;

function events(rows: [number, number, 0 | 1 | 2 | 3][]): ProductEvents {
  const sorted = [...rows].sort((a, b) => a[0] - b[0]);
  return { at: Float64Array.from(sorted.map((r) => r[0])), qty: Float32Array.from(sorted.map((r) => r[1])), kind: Uint8Array.from(sorted.map((r) => r[2])) };
}

test("«Сосиска в тесте»: put 7 → sold 6 within 48 h → 1 left and written off; sell-through 6 of 7", () => {
  const ev = events([
    [at(0, 7), 7, 1],
    [at(0, 10), 1, 0],
    [at(0, 12), 2, 0],
    [at(0, 15), 1, 0],
    [at(1, 9), 1, 0],
    [at(1, 13), 1, 0],
    [at(2, 9), 1, 3], // the last one written off after the 48 h
  ]);
  const r = analyseBatches({ events: ev, from: at(0, 0), now: at(3, 0), currentStock: 0, shelfHours: 48 });
  assert.equal(r.batches.length, 1);
  const b = r.batches[0];
  assert.deepEqual(
    [b.loaded, b.before, b.sold24, b.soldInShelf, b.soldAfter, b.unloaded, b.writtenOff, b.leftAtExpiry, b.complete, b.soldOut],
    [7, 0, 4, 6, 0, 0, 1, 1, true, false],
  );
  assert.ok(r.consistent);
  assert.equal(r.replayStock, 0);
});

test("FIFO across daily deliveries: the old units sell first, the new delivery is measured on its own", () => {
  const ev = events([
    [at(0, 7), 6, 1],
    [at(0, 12), 4, 0], // day 1: 4 of the 6
    [at(1, 7), 6, 1], // day 2: 2 old + 6 new
    [at(1, 12), 5, 0], // 2 old + 3 new
    [at(2, 7), 1, 2], // an unload: takes the oldest — of the second delivery (the first one is empty)
  ]);
  const r = analyseBatches({ events: ev, from: at(0, 0), now: at(4, 0), currentStock: 2, shelfHours: 48 });
  const [b1, b2] = r.batches;
  assert.deepEqual([b1.loaded, b1.soldInShelf, b1.leftAtExpiry, b1.soldOut], [6, 6, 0, true]);
  assert.deepEqual([b2.loaded, b2.before, b2.soldInShelf, b2.unloaded, b2.leftAtExpiry], [6, 2, 3, 1, 2]);
  assert.equal(r.expiredNow, 2, "2 units of the second delivery are older than 48 h now");
});

test("loads within an hour are one delivery; ages of the stock; the stock before a delivery", () => {
  const ev = events([
    [at(0, 7), 3, 1],
    [at(0, 7.5), 2, 1], // the same delivery
    [at(1, 8), 4, 1],
  ]);
  const r = analyseBatches({ events: ev, from: at(0, 0), now: at(1, 20), currentStock: 9, shelfHours: 72 });
  assert.equal(r.batches.length, 2);
  assert.equal(r.batches[0].loaded, 5);
  assert.equal(r.batches[1].before, 5);
  assert.deepEqual(r.ages.map((a) => [a.from, a.to, a.qty]), [[0, 24, 4], [24, 48, 5], [48, 72, 0]]);
  assert.equal(r.expiredNow, 0);
});

test("movements that do not add up with the real stock are flagged, never invented", () => {
  const ev = events([
    [at(0, 7), 5, 1],
    [at(0, 9), 1, 0], // loaded 5, sold 1, but KiT Shop has 0 now — a movement we do not see
  ]);
  const r = analyseBatches({ events: ev, from: at(0, 0), now: at(3, 0), currentStock: 0, shelfHours: 48 });
  assert.equal(r.consistent, false);
  assert.equal(r.startStock, -4);
});

test("a data gap inside the shelf-life window makes the delivery incomplete (not used for the norm)", () => {
  const ev = events([
    [at(0, 7), 5, 1],
    [at(0, 12), 5, 0],
  ]);
  const gap = new Set([Math.floor(at(1, 0) / DAY)]);
  const r = analyseBatches({ events: ev, from: at(0, 0), now: at(4, 0), currentStock: 0, shelfHours: 48, gapDays: gap });
  assert.equal(r.batches[0].complete, false);
});
