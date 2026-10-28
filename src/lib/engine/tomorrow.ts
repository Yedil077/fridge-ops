import type { FridgeForecast, NetworkSnapshot } from "../domain/types";
import { analyseBatches } from "./batches";
import { shareLeft } from "./demand";
import { quantile, type ProductStats } from "./productNorm";
import { dayNumber, weekdayOf } from "../time";

/**
 * TOMORROW — how many of each dish of tomorrow's menu to put into each fridge. Apps Холодосов does NOT choose the menu
 * (the kitchen / manager does); it only says HOW MANY, in whole units:
 *
 *   base   = the fridge's norm for this dish (engine/productNorm.ts: what sells within the shelf life over the last
 *            deliveries; +1 when the last 3 sold out — "проверить больше"; less when the leftovers keep being written off)
 *            · only 1–2 deliveries known → what they sold, LOW confidence
 *            · never at this fridge → the same dish in the fridges of its transfer group (median norm), then in the
 *              whole network; LOW, "НОВЫЙ" — never a category average
 *            · nothing anywhere → "?" (no invented number)
 *   left   = what will still be FRESH tomorrow morning: today's units minus what sells for the rest of today (the oldest
 *            go first), without the units whose shelf life ends by then
 *   tomorrow = max(0, base − left);  0 when the fridge does not work on that weekday.
 */

export const TOMORROW_DELIVERY_HOUR = 7;
const H = 3_600_000;
const DAY = 24 * H;

export interface DeliveryLine {
  at: number;
  loaded: number;
  sold: number;
  unloaded: number;
  writtenOff: number;
  left: number | null;
  soldOut: boolean;
}

export interface TomorrowCell {
  shopId: string;
  productId: string;
  /** null = "?" — not enough data for any number */
  qty: number | null;
  base: number | null;
  range: { min: number; max: number } | null;
  expectedLeft: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  tag: "НОВЫЙ" | "МАЛО ДАННЫХ" | "НЕ РАБОТАЕТ" | "ДАННЫЕ НЕПОЛНЫЕ" | null;
  /** where the base came from */
  basis: "ЭТА ТОЧКА" | "ГРУППА" | "СЕТЬ" | null;
  reason: {
    deliveries: DeliveryLine[];
    /** how many of the deliveries sold out completely */
    soldOutCount: number;
    writeOff: "низкое" | "среднее" | "высокое" | "нет данных";
    notes: string[];
    today: { loaded: number; soldSoFar: number } | null;
  };
}

export function computeTomorrow(input: {
  snap: NetworkSnapshot;
  forecasts: FridgeForecast[];
  stats: ProductStats;
  /** tomorrow's menu: our product ids ("K123") */
  menu: string[];
  /** day number of "tomorrow" */
  day: number;
  /** receipts per day of each shop (nightly job): to know whether the fridge works on that weekday */
  receiptsByDay?: (shopId: string, day: number) => number | null;
}): TomorrowCell[] {
  const { snap, stats } = input;
  const P = snap.products.length;
  const pIdx = new Map(snap.products.map((p, i) => [p.id, i]));
  const now = snap.now;
  const deliveryAt = input.day * DAY + TOMORROW_DELIVERY_HOUR * H;
  const nowMinute = Math.floor((now - dayNumber(now) * DAY) / 60_000);
  const out: TomorrowCell[] = [];

  for (const pid of input.menu) {
    const p = pIdx.get(pid);
    // the norms of the same dish in other fridges — for a fridge that never had it: its transfer group first, then the network
    const normOf = (f: number) => (p === undefined ? undefined : stats.at[f * P + p]?.norm?.rec ?? snap.productDays?.stats[f * P + p]?.norm?.rec);
    const median = (fs: number[]) => {
      const xs = fs.map(normOf).filter((x): x is number => typeof x === "number" && x > 0).sort((a, b) => a - b);
      return xs.length ? { value: quantile(xs, 0.5), n: xs.length } : null;
    };

    snap.fridges.forEach((fr, f) => {
      const notes: string[] = [];
      const cell: TomorrowCell = {
        shopId: fr.externalId,
        productId: pid,
        qty: null,
        base: null,
        range: null,
        expectedLeft: 0,
        confidence: "LOW",
        tag: null,
        basis: null,
        reason: { deliveries: [], soldOutCount: 0, writeOff: "нет данных", notes, today: null },
      };
      out.push(cell);

      // does the fridge work on that weekday? (the same weekday of the last 4 weeks)
      if (input.receiptsByDay) {
        const same = [7, 14, 21, 28].map((w) => input.receiptsByDay!(fr.externalId, input.day - w)).filter((x): x is number => x !== null);
        if (same.length >= 3 && same.filter((x) => x > 0).length <= 1) {
          cell.qty = 0;
          cell.confidence = "MEDIUM";
          cell.tag = "НЕ РАБОТАЕТ";
          notes.push(`по этим дням недели (${["", "пн", "вт", "ср", "чт", "пт", "сб", "вс"][weekdayOf(input.day)]}) холодильник обычно не работает`);
          return;
        }
      }

      // data checks of this fridge red (time, new receipts, gaps…) → no number a manager would trust
      const failed = (snap.productDays?.checks[f] ?? []).filter((x) => x.level === "FAIL");
      if (failed.length) {
        cell.tag = "ДАННЫЕ НЕПОЛНЫЕ";
        notes.push(`Недостаточно данных: проверка данных не пройдена (${failed.map((x) => x.label.toLowerCase()).join(", ")}) — числа не будет, пока данные не исправлены`);
        return;
      }

      const st = p === undefined ? undefined : stats.at[f * P + p];
      const stored = p === undefined ? undefined : snap.productDays?.stats[f * P + p];
      const done = (st?.recent ?? stored?.recent ?? []).filter((b) => b.complete);
      cell.reason.deliveries = done.slice(0, 8).map((b) => ({ at: b.at, loaded: b.loaded, sold: b.soldInShelf, unloaded: b.unloaded, writtenOff: b.writtenOff, left: b.leftAtExpiry, soldOut: b.soldOut }));
      cell.reason.soldOutCount = done.filter((b) => b.soldOut).length;
      const batches = st?.batches ?? stored?.batches;
      if (batches && batches.loaded > 0) {
        const w = batches.writtenOff / batches.loaded;
        cell.reason.writeOff = w < 0.05 ? "низкое" : w < 0.15 ? "среднее" : "высокое";
      }
      if (st?.current) cell.reason.today = { loaded: st.current.loaded, soldSoFar: st.current.soldSoFar };

      // the base number
      const norm = st?.norm ?? stored?.norm ?? null;
      const group = fr.transferGroup ? median(snap.fridges.map((x, i) => (i !== f && x.transferGroup === fr.transferGroup ? i : -1)).filter((i) => i >= 0)) : null;
      const network = median(snap.fridges.map((_, i) => i).filter((i) => i !== f));
      if (norm) {
        cell.basis = "ЭТА ТОЧКА";
        cell.base = norm.rec;
        cell.range = { min: norm.min, max: norm.max };
        cell.confidence = st?.norm ? st.confidence : "LOW";
      } else if (done.length) {
        const sold = done.map((b) => b.soldInShelf).sort((a, b) => a - b);
        cell.base = Math.max(1, sold[Math.floor(sold.length / 2)]);
        cell.basis = "ЭТА ТОЧКА";
        cell.tag = "МАЛО ДАННЫХ";
        notes.push(`только ${done.length} ${done.length === 1 ? "поставка" : "поставки"} в истории этой точки`);
      } else if (group) {
        cell.base = group.value;
        cell.basis = "ГРУППА";
        cell.tag = "НОВЫЙ";
        notes.push(`в этом холодильнике блюда не было — в холодильниках группы ${fr.transferGroup} (${group.n}) обычно ${group.value} шт.`);
      } else if (network) {
        cell.base = network.value;
        cell.basis = "СЕТЬ";
        cell.tag = "НОВЫЙ";
        notes.push(`ни в этом холодильнике, ни в группе блюда не было — по сети (${network.n} холодильников) обычно ${network.value} шт.`);
      } else {
        cell.tag = "НОВЫЙ";
        notes.push("блюда не было ни в одном холодильнике — точного числа нет; осторожный старт 1–2 шт., решает менеджер");
        return;
      }

      // what will still be fresh tomorrow morning
      const shelfH = st?.shelfHours ?? stored?.shelfHours ?? 48;
      const stock = p === undefined ? 0 : snap.stock[f * P + p];
      if (stock > 0 && snap.productDays && p !== undefined) {
        const live = analyseBatches({ events: snap.productDays.recent[f * P + p], from: snap.productDays.recentFrom, now, currentStock: stock, shelfHours: shelfH });
        // the rest of today sells first from the oldest units
        let sellToday = Math.round(cell.base * shareLeft(input.forecasts[f], nowMinute, 1440));
        let left = 0;
        for (const lot of live.lots) {
          const take = Math.min(lot.left, sellToday);
          sellToday -= take;
          const remain = lot.left - take;
          if (remain > 0 && lot.at !== null && deliveryAt - lot.at < shelfH * H) left += remain;
        }
        cell.expectedLeft = Math.round(left);
        if (cell.expectedLeft) notes.push(`к утру останется годных ~${cell.expectedLeft} шт. — их не ставим заново`);
      }
      cell.qty = Math.max(0, cell.base - cell.expectedLeft);
    });
  }
  return out;
}
