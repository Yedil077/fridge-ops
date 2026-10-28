import type { ProductEvents } from "../domain/types";

/**
 * DELIVERY BATCHES — how the business really works: a dish is put into a fridge, it sells for its shelf life
 * (48 h main dishes, 72 h desserts and drinks), what is left is taken out or written off.
 *
 * Every movement of one dish in one fridge is replayed in time order with FIRST-IN-FIRST-OUT: a sale, an unload
 * («снято») or a write-off always takes the OLDEST units first. So each delivery (a load; loads within an hour are one
 * delivery) gets its own result:
 *   stock before · loaded · sold in 24 h · sold within its shelf life · sold after it · unloaded · written off ·
 *   left when the shelf life ended ·  sell-through = sold within shelf life ÷ loaded.
 * The stock at the start is what the movements imply (now − all movements since then); if they do not add up
 * (negative), the start is 0 and the dish is marked "движение не сходится".
 * Only real KiT Shop movements are used; days with a data gap make the batches around them incomplete.
 */

export const DAY_MS = 86_400_000;
const H = 3_600_000;
/** loads of the same dish closer than this are one delivery */
const MERGE_MS = H;

export interface Batch {
  at: number;
  loaded: number;
  /** units already in the fridge when it came */
  before: number;
  sold24: number;
  soldInShelf: number;
  soldAfter: number;
  unloaded: number;
  writtenOff: number;
  /** units still there when the shelf life ended (null = not ended yet) */
  leftAtExpiry: number | null;
  /** shelf life ended and no data gap inside its window */
  complete: boolean;
  /** all units sold within the shelf life */
  soldOut: boolean;
}

export interface BatchResult {
  batches: Batch[];
  /** units in the fridge now by age; expired = older than the shelf life */
  ages: { from: number; to: number; qty: number }[];
  expiredNow: number;
  /** now − movements: the stock implied at `from`; negative = movements KiT Shop does not show */
  startStock: number;
  consistent: boolean;
  /** what the replay ends with vs the real stock from KiT Shop */
  replayStock: number;
  /** sales that found no unit (start stock unknown / movements missing) */
  unattributed: number;
  /** units still in the fridge, oldest first: when they came (null = before the replay, age unknown) */
  lots: { at: number | null; left: number }[];
}

interface Lot {
  batch: Batch | null; // null = the start stock (age unknown)
  at: number;
  left: number;
}

export function analyseBatches(input: {
  events: ProductEvents | undefined;
  from: number;
  now: number;
  currentStock: number;
  shelfHours: number;
  /** day numbers with a data gap */
  gapDays?: Set<number>;
}): BatchResult {
  const { from, now, currentStock } = input;
  const shelf = input.shelfHours * H;
  const ev = input.events;
  const idx: number[] = [];
  if (ev) for (let i = 0; i < ev.at.length; i++) if (ev.at[i] >= from && ev.at[i] <= now) idx.push(i);

  // stock at `from` implied by the movements
  let net = 0;
  for (const i of idx) net += ev!.kind[i] === 1 ? ev!.qty[i] : -ev!.qty[i];
  const startStock = currentStock - net;
  const consistent = startStock >= 0;

  const lots: Lot[] = [];
  if (startStock > 0) lots.push({ batch: null, at: from - shelf / 2, left: startStock });
  const batches: Batch[] = [];
  let unattributed = 0;
  const expire = (t: number) => {
    for (const l of lots) if (l.batch && l.batch.leftAtExpiry === null && l.at + shelf <= t) l.batch.leftAtExpiry = l.left;
  };
  const take = (qty: number, t: number, onTake: (l: Lot, n: number) => void) => {
    let rest = qty;
    for (const l of lots) {
      if (rest <= 0) break;
      if (l.left <= 0) continue;
      const n = Math.min(l.left, rest);
      l.left -= n;
      rest -= n;
      onTake(l, n);
    }
    void t;
    return rest;
  };

  for (const i of idx) {
    const t = ev!.at[i];
    const q = ev!.qty[i];
    const k = ev!.kind[i];
    expire(t);
    if (k === 1) {
      const last = batches[batches.length - 1];
      if (last && t - last.at <= MERGE_MS) {
        last.loaded += q;
        const lot = lots.find((l) => l.batch === last);
        if (lot) lot.left += q;
        else lots.push({ batch: last, at: last.at, left: q });
      } else {
        const before = lots.reduce((a, l) => a + l.left, 0);
        const b: Batch = { at: t, loaded: q, before, sold24: 0, soldInShelf: 0, soldAfter: 0, unloaded: 0, writtenOff: 0, leftAtExpiry: null, complete: false, soldOut: false };
        batches.push(b);
        lots.push({ batch: b, at: t, left: q });
      }
    } else if (k === 0) {
      unattributed += take(q, t, (l, n) => {
        if (!l.batch) return;
        if (t < l.at + 24 * H) l.batch.sold24 += n;
        if (t < l.at + shelf) l.batch.soldInShelf += n;
        else l.batch.soldAfter += n;
      });
    } else {
      take(q, t, (l, n) => {
        if (!l.batch) return;
        if (k === 2) l.batch.unloaded += n;
        else l.batch.writtenOff += n;
      });
    }
    // drop empty lots at the front
    while (lots.length && lots[0].left <= 0) lots.shift();
  }
  expire(now);

  for (const b of batches) {
    const end = b.at + shelf;
    // its lot was emptied (and dropped) before the shelf life ended → nothing was left
    if (b.leftAtExpiry === null && end <= now) b.leftAtExpiry = 0;
    let gap = false;
    if (input.gapDays) for (let d = Math.floor(b.at / DAY_MS); d <= Math.floor(Math.min(end, now) / DAY_MS); d++) if (input.gapDays.has(d)) gap = true;
    b.complete = end <= now && !gap;
    b.soldOut = b.soldInShelf >= b.loaded;
  }

  const ages = [0, 1, 2].filter((x) => x * 24 * H < shelf).map((x) => ({ from: x * 24, to: Math.min((x + 1) * 24, input.shelfHours), qty: 0 }));
  let expiredNow = 0;
  let replayStock = 0;
  for (const l of lots) {
    if (l.left <= 0) continue;
    replayStock += l.left;
    const age = now - l.at;
    if (!l.batch || age >= shelf) {
      expiredNow += l.batch ? l.left : 0;
      if (l.batch) continue;
    }
    const slot = ages.find((a) => age < a.to * H) ?? ages[ages.length - 1];
    if (l.batch) slot.qty += l.left;
  }
  // the start stock of unknown age is counted as the oldest
  const unknownAge = lots.filter((l) => !l.batch).reduce((a, l) => a + l.left, 0);
  if (unknownAge > 0) ages[ages.length - 1].qty += unknownAge;

  return { batches, ages, expiredNow, startStock, consistent, replayStock, unattributed, lots: lots.filter((l) => l.left > 0).map((l) => ({ at: l.batch ? l.at : null, left: l.left })) };
}
