import { CATEGORIES } from "../domain/categories";
import { QUARTERS, type NetworkSnapshot } from "../domain/types";
import { hashSeed, lognormal, mulberry32, pickWeighted, poisson, uniform, type Rng } from "../random";
import { DAY_MS, MINUTE_MS, weekdayOf } from "../time";
import { NETWORK_MIX } from "./archetypes";
import { buildHistoryCube, buildModel, dayShares, expectedDaily, isOpenDay, type RecordedDay, type SimModel } from "./model";

/**
 * Live simulator: plays "today" in 15-minute steps on top of 180 days of generated history.
 * It is the MOCK data source — it replaces KitShop during development. Its state is plain JSON.
 */

export const HISTORY_DAYS = 180;
const C = CATEGORIES.length;
const KEEP_RECORDED_DAYS = 60;

export interface SimEvent {
  fridgeIndex: number;
  categoryIndex: number; // -1 = all categories
  multiplier: number;
  untilMinute: number;
  label: string;
}

export interface SimState {
  version: number;
  seed: number;
  anchorDay: number;
  day: number;
  /** minutes from 00:00 of `day` */
  minute: number;
  stock: number[]; // F*P
  dayStartStock: number[]; // F*P
  quarterSales: number[]; // F*C*96
  productSales: number[]; // F*P
  stockout: number[]; // F*C*96
  revenue: number[]; // F
  lostSales: number[]; // F*C
  deliveries: number[]; // F*C
  todayFactor: number[]; // F
  events: SimEvent[];
  waste: { day: number; units: number[] }[]; // units F*C
  recorded: Record<string, RecordedDay>;
  log: { at: number; text: string }[];
}

export interface DayRollInfo {
  endedDay: number;
}

export class Simulator {
  model: SimModel;
  state: SimState;
  private cubeCache: { key: string; cube: ReturnType<typeof buildHistoryCube> } | null = null;

  constructor(state: SimState) {
    this.state = state;
    this.model = buildModel(state.seed, state.anchorDay);
  }

  static create(seed: number, today: number, startMinute = 8 * 60): Simulator {
    const model = buildModel(seed, today);
    const F = model.fridges.length;
    const P = model.products.length;
    const state: SimState = {
      version: 1,
      seed,
      anchorDay: today,
      day: today,
      minute: 0,
      stock: new Array(F * P).fill(0),
      dayStartStock: new Array(F * P).fill(0),
      quarterSales: new Array(F * C * QUARTERS).fill(0),
      productSales: new Array(F * P).fill(0),
      stockout: new Array(F * C * QUARTERS).fill(0),
      revenue: new Array(F).fill(0),
      lostSales: new Array(F * C).fill(0),
      deliveries: new Array(F * C).fill(0),
      todayFactor: new Array(F).fill(1),
      events: [],
      waste: [],
      recorded: {},
      log: [],
    };
    const sim = new Simulator(state);
    sim.model = model;
    // yesterday's leftovers: a small random carry-over of long-life items
    const rng = sim.rng(99);
    for (let f = 0; f < F; f++) {
      for (let p = 0; p < P; p++) {
        const cat = model.products[p].categoryId;
        if (cat === "drink" || cat === "snack") state.stock[f * P + p] = Math.floor(rng() * 3);
      }
    }
    sim.startDay();
    sim.advance(startMinute);
    sim.pushLog("Симулятор создан: 15 холодильников, 180 дней истории");
    return sim;
  }

  get F() {
    return this.model.fridges.length;
  }
  get P() {
    return this.model.products.length;
  }
  get now(): number {
    return this.state.day * DAY_MS + this.state.minute * MINUTE_MS;
  }

  private rng(salt: number): Rng {
    return mulberry32(hashSeed(this.state.seed, this.state.day, this.state.minute, salt, this.state.version));
  }

  private pushLog(text: string) {
    this.state.log.unshift({ at: this.now, text });
    this.state.log = this.state.log.slice(0, 40);
  }

  private touch() {
    this.state.version++;
  }

  // ───────────────────────── day lifecycle ─────────────────────────

  /** Morning: new demand factor and deliveries planned by NETWORK-AVERAGE mix (source of imbalances). */
  private startDay() {
    const s = this.state;
    const { F, P } = this;
    const rng = mulberry32(hashSeed(s.seed, s.day, 555));
    s.quarterSales.fill(0);
    s.productSales.fill(0);
    s.stockout.fill(0);
    s.revenue.fill(0);
    s.lostSales.fill(0);
    s.deliveries.fill(0);
    s.events = [];
    for (let f = 0; f < F; f++) {
      s.todayFactor[f] = lognormal(rng, 0.14);
      if (!isOpenDay(this.model, f, s.day)) continue;
      const a = this.model.archetypes[f];
      let planned = 0;
      const dayW = this.model.dayWeight[f][weekdayOf(s.day) - 1];
      for (let c = 0; c < C; c++) planned += expectedDaily(this.model, f, c, s.day) * dayW;
      planned *= uniform(rng, 1.1, 1.3);
      for (let c = 0; c < C; c++) {
        const cid = CATEGORIES[c].id;
        const carried = this.categoryStock(f, c);
        const target = planned * NETWORK_MIX[cid] * uniform(rng, 0.85, 1.3);
        const qty = Math.max(0, Math.round(target - 0.6 * carried));
        s.deliveries[f * C + c] = qty;
        const prods = this.model.catProducts[c];
        for (let u = 0; u < qty; u++) {
          const k = Math.floor(rng() * prods.length);
          s.stock[f * P + prods[k]] += 1;
        }
      }
      // never exceed physical capacity
      let total = this.fridgeStock(f);
      while (total > a.capacity) {
        const p = Math.floor(rng() * P);
        if (s.stock[f * P + p] > 0) {
          s.stock[f * P + p]--;
          total--;
        }
      }
    }
    s.dayStartStock = [...s.stock];
  }

  /** Close of day: waste by shelf life, record the day into history, move to the next day. */
  private endDay(): DayRollInfo {
    const s = this.state;
    const { F, P } = this;
    const endedDay = s.day;
    const rng = mulberry32(hashSeed(s.seed, s.day, 777));
    const wasteUnits = new Array(F * C).fill(0);
    for (let f = 0; f < F; f++) {
      const tomorrowOpen = isOpenDay(this.model, f, s.day + 1);
      for (let c = 0; c < C; c++) {
        const share = CATEGORIES[c].wasteShare[tomorrowOpen ? 0 : 1];
        if (share <= 0) continue;
        for (const p of this.model.catProducts[c]) {
          const have = s.stock[f * P + p];
          let w = 0;
          for (let u = 0; u < have; u++) if (rng() < share) w++;
          s.stock[f * P + p] -= w;
          wasteUnits[f * C + c] += w;
        }
      }
    }
    s.waste.unshift({ day: s.day, units: wasteUnits });
    s.waste = s.waste.slice(0, 30);

    const hourly = new Array(F * C * 24).fill(0);
    for (let i = 0; i < F * C; i++)
      for (let q = 0; q < QUARTERS; q++) hourly[i * 24 + Math.floor(q / 4)] += s.quarterSales[i * QUARTERS + q];
    s.recorded[String(s.day)] = { hourly, product: [...s.productSales] };
    const keys = Object.keys(s.recorded).map(Number).sort((a, b) => b - a);
    for (const k of keys.slice(KEEP_RECORDED_DAYS)) delete s.recorded[String(k)];

    const totalWaste = wasteUnits.reduce((a, b) => a + b, 0);
    s.day += 1;
    s.minute = 0;
    this.startDay();
    this.pushLog(`Новый день. Списано вчера: ${totalWaste} шт.`);
    return { endedDay };
  }

  // ───────────────────────── time ─────────────────────────

  /** Advances the clock. Returns info about rolled days so the runtime can evaluate missions first. */
  advance(minutes: number, onBeforeDayEnd?: () => void): DayRollInfo[] {
    const rolls: DayRollInfo[] = [];
    let left = Math.max(0, Math.round(minutes));
    while (left > 0) {
      const q = Math.floor(this.state.minute / 15);
      this.simulateQuarter(q, 1);
      const step = 15 - (this.state.minute % 15);
      this.state.minute += step;
      left -= step;
      if (this.state.minute >= 1440) {
        onBeforeDayEnd?.();
        rolls.push(this.endDay());
      }
    }
    this.touch();
    return rolls;
  }

  private demandMultiplier(f: number, c: number): number {
    let m = this.state.todayFactor[f];
    for (const e of this.state.events) {
      if (e.fridgeIndex === f && (e.categoryIndex === -1 || e.categoryIndex === c) && this.state.minute < e.untilMinute)
        m *= e.multiplier;
    }
    return m;
  }

  /** Plays one quarter-hour of sales (scale = fraction of quarter demand). */
  private simulateQuarter(q: number, scale: number) {
    const s = this.state;
    const { F, P } = this;
    const rng = this.rng(q + 1000);
    for (let f = 0; f < F; f++) {
      if (!isOpenDay(this.model, f, s.day)) continue;
      for (let c = 0; c < C; c++) {
        const share = dayShares(this.model, f, c, s.day)[q];
        if (share <= 0) continue;
        const lambda = expectedDaily(this.model, f, c, s.day) * share * this.demandMultiplier(f, c) * scale;
        const demand = poisson(rng, lambda);
        const prods = this.model.catProducts[c];
        let sold = 0;
        for (let u = 0; u < demand; u++) {
          const weights = prods.map((p) => (s.stock[f * P + p] > 0 ? this.model.productWeight[f][p] : 0));
          const k = pickWeighted(rng, weights);
          if (k < 0) break;
          const p = prods[k];
          s.stock[f * P + p]--;
          s.productSales[f * P + p]++;
          s.revenue[f] += this.model.products[p].price;
          sold++;
        }
        s.quarterSales[(f * C + c) * QUARTERS + q] += sold;
        s.lostSales[f * C + c] += demand - sold;
        if (this.categoryStock(f, c) === 0) s.stockout[(f * C + c) * QUARTERS + q] = 1;
      }
    }
  }

  // ───────────────────────── stock helpers ─────────────────────────

  categoryStock(f: number, c: number): number {
    let n = 0;
    for (const p of this.model.catProducts[c]) n += this.state.stock[f * this.P + p];
    return n;
  }

  fridgeStock(f: number): number {
    let n = 0;
    for (let p = 0; p < this.P; p++) n += this.state.stock[f * this.P + p];
    return n;
  }

  /** Physical transfer in MOCK mode (in real mode stock comes from KitShop; we never write there). */
  applyTransfer(source: number, target: number, items: { productIndex: number; qty: number }[]): number {
    let moved = 0;
    for (const it of items) {
      const have = this.state.stock[source * this.P + it.productIndex];
      const q = Math.min(have, Math.max(0, it.qty));
      this.state.stock[source * this.P + it.productIndex] -= q;
      this.state.stock[target * this.P + it.productIndex] += q;
      moved += q;
    }
    this.touch();
    return moved;
  }

  /** MOCK only: a confirmed load (+) / unload or write-off (−) from the fake KiT Shop. Never below 0. */
  adjustStock(f: number, productIndex: number, delta: number): number {
    const i = f * this.P + productIndex;
    const next = Math.max(0, this.state.stock[i] + Math.round(delta));
    const applied = next - this.state.stock[i];
    this.state.stock[i] = next;
    this.touch();
    return applied;
  }

  // ───────────────────────── dev panel actions ─────────────────────────

  private openFridges(): number[] {
    const out: number[] = [];
    for (let f = 0; f < this.F; f++) {
      // fridges that really sell during the next hour (simulated activity, not the configured schedule)
      const q = Math.floor(this.state.minute / 15);
      if (isOpenDay(this.model, f, this.state.day) && q + 4 < QUARTERS && dayShares(this.model, f, 0, this.state.day)[q + 4] > 0) out.push(f);
    }
    return out;
  }

  private topCategory(f: number, highest: boolean, perishableOnly = false): number {
    const shares = this.model.mixShare[f];
    let best = -1;
    for (let c = 0; c < C; c++) {
      if (perishableOnly && CATEGORIES[c].wasteShare[0] === 0) continue;
      if (best < 0 || (highest ? shares[c] > shares[best] : shares[c] < shares[best])) best = c;
    }
    return best;
  }

  /** Instant burst of sales (~30 min of demand across the network) without moving the clock. */
  simulateSales(): string {
    const q = Math.min(95, Math.floor(this.state.minute / 15));
    this.simulateQuarter(q, 2);
    this.touch();
    const text = "Всплеск продаж по сети (~30 минут спроса)";
    this.pushLog(text);
    return text;
  }

  createShortage(): string {
    const open = this.openFridges();
    if (!open.length) return "Нет открытых холодильников";
    const rng = this.rng(11);
    const f = open[Math.floor(rng() * open.length)];
    const c = this.topCategory(f, true, true);
    let keep = 1;
    for (const p of this.model.catProducts[c]) {
      const i = f * this.P + p;
      if (this.state.stock[i] > 0 && keep > 0) {
        this.state.stock[i] = 1;
        keep--;
      } else this.state.stock[i] = 0;
    }
    this.touch();
    const text = `Дефицит: ${this.model.fridges[f].name} · ${CATEGORIES[c].name} → 1 шт.`;
    this.pushLog(text);
    return text;
  }

  createOverstock(): string {
    const open = this.openFridges();
    if (!open.length) return "Нет открытых холодильников";
    const rng = this.rng(12);
    const f = open[Math.floor(rng() * open.length)];
    const c = this.topCategory(f, false, true);
    const prods = this.model.catProducts[c];
    for (let u = 0; u < 14; u++) this.state.stock[f * this.P + prods[Math.floor(rng() * prods.length)]]++;
    this.touch();
    const text = `Излишек: ${this.model.fridges[f].name} · ${CATEGORIES[c].name} +14 шт.`;
    this.pushLog(text);
    return text;
  }

  createAnomaly(): string {
    const open = this.openFridges();
    if (!open.length) return "Нет открытых холодильников";
    const rng = this.rng(13);
    const f = open[Math.floor(rng() * open.length)];
    this.state.events.push({ fridgeIndex: f, categoryIndex: -1, multiplier: 1.9, untilMinute: 1440, label: "Аномальный спрос" });
    this.touch();
    const text = `Аномалия: ${this.model.fridges[f].name} — спрос ×1.9 до конца дня`;
    this.pushLog(text);
    return text;
  }

  resetDay(startMinute = 8 * 60): string {
    this.state.stock = [...this.state.dayStartStock];
    const keepStart = [...this.state.dayStartStock];
    // restart the day without re-delivering
    const s = this.state;
    s.quarterSales.fill(0);
    s.productSales.fill(0);
    s.stockout.fill(0);
    s.revenue.fill(0);
    s.lostSales.fill(0);
    s.events = [];
    s.minute = 0;
    s.stock = keepStart;
    this.advance(startMinute);
    const text = "День сброшен к утру";
    this.pushLog(text);
    return text;
  }

  // ───────────────────────── snapshot ─────────────────────────

  history() {
    const key = `${this.state.seed}:${this.state.day}:${Object.keys(this.state.recorded).length}`;
    if (!this.cubeCache || this.cubeCache.key !== key) {
      this.cubeCache = { key, cube: buildHistoryCube(this.model, this.state.day, HISTORY_DAYS, this.state.recorded) };
    }
    return this.cubeCache.cube;
  }

  snapshot(): NetworkSnapshot {
    const s = this.state;
    return {
      now: this.now,
      fridges: this.model.fridges,
      categories: CATEGORIES,
      products: this.model.products,
      history: this.history(),
      today: {
        day: s.day,
        quarterSales: Float32Array.from(s.quarterSales),
        productSales: Float32Array.from(s.productSales),
        stockoutQuarters: Uint8Array.from(s.stockout),
        revenue: Float32Array.from(s.revenue),
      },
      stock: Int32Array.from(s.stock),
      travelMinutes: this.model.travel,
      version: `mock:${s.seed}:${s.day}:${s.minute}:${s.version}`,
      source: "mock",
    };
  }
}
