import { CATEGORIES } from "../domain/categories";
import type { CategoryId, Fridge, HistoryCube, Product } from "../domain/types";
import { buildTravelMatrix } from "../engine/distance";
import { hashSeed, lognormal, mulberry32, pickWeighted, poisson, type Rng } from "../random";
import { dayNumber, dayOfMonth, daysInMonth, DAY_MS, weekdayOf } from "../time";
import { ARCHETYPES, HOLIDAYS_MMDD, NETWORK_CENTER, NETWORK_MIX, PRODUCT_DEFS, type Archetype } from "./archetypes";

/**
 * Demand model of the simulator. Produces "true" demand; the engine only sees resulting sales.
 */
export interface SimModel {
  seed: number;
  anchorDay: number;
  archetypes: Archetype[];
  fridges: Fridge[];
  products: Product[];
  /** [f][c][96] share of the category's daily demand in each quarter-hour */
  quarterShare: number[][][];
  /** [f][c] share of daily demand per category */
  mixShare: number[][];
  /** [f][p] relative product preference within its category */
  productWeight: number[][];
  /** [c] → product indices */
  catProducts: number[][];
  holidays: Set<number>;
  travel: number[][];
}

const C = CATEGORIES.length;

function categoryTimeFactor(cat: CategoryId, t: number): number {
  switch (cat) {
    case "breakfast":
      return t < 10.5 ? 2.6 : t < 12 ? 1 : 0.25;
    case "hot":
      return t >= 11 && t < 15 ? 1.5 : t >= 17.5 ? 1.1 : 0.6;
    case "salad":
      return t >= 11 && t < 15 ? 1.3 : 0.8;
    case "dessert":
      return t >= 14 && t < 18.5 ? 1.4 : t < 11 ? 0.6 : 1;
    default:
      return 1;
  }
}

function holidayDays(fromDay: number, toDay: number): Set<number> {
  const set = new Set<number>();
  const y0 = new Date(fromDay * DAY_MS).getUTCFullYear();
  const y1 = new Date(toDay * DAY_MS).getUTCFullYear();
  for (let y = y0; y <= y1; y++) {
    for (const mmdd of HOLIDAYS_MMDD) {
      const [m, d] = mmdd.split("-").map(Number);
      set.add(dayNumber(Date.UTC(y, m - 1, d)));
    }
  }
  return set;
}

export function buildModel(seed: number, anchorDay: number): SimModel {
  const rng = mulberry32(hashSeed(seed, 7));
  const catIds = CATEGORIES.map((c) => c.id);

  const SKU_PREFIX: Record<string, string> = { breakfast: "ЗВ", hot: "ГР", salad: "СЛ", snack: "ПР", dessert: "ДС", drink: "НП" };
  const perCat: Record<string, number> = {};
  const products: Product[] = PRODUCT_DEFS.map((p, i) => {
    perCat[p.category] = (perCat[p.category] ?? 0) + 1;
    return {
      id: `P${String(i + 1).padStart(3, "0")}`,
      externalId: `mock-product-${i + 1}`,
      name: p.name,
      categoryId: p.category,
      price: p.price,
      sku: `${SKU_PREFIX[p.category]}-${String(perCat[p.category]).padStart(2, "0")}`,
      imageUrl: null,
      barcode: `46000000${String(i + 1).padStart(5, "0")}`,
    };
  });
  const catProducts = catIds.map((cid) => products.map((p, i) => (p.categoryId === cid ? i : -1)).filter((i) => i >= 0));

  const cosLat = Math.cos((NETWORK_CENTER.lat * Math.PI) / 180);
  const fridges: Fridge[] = ARCHETYPES.map((a) => ({
    id: `F${a.code}`,
    externalId: a.kitshopId ?? `mock-shop-${a.code}`,
    code: a.code,
    name: a.name ?? `Fridge ${a.code}`,
    shortName: a.shortName ?? a.name ?? `Fridge ${a.code}`,
    priority: 2,
    proximityGroup: a.zone,
    transferGroup: a.transferGroup ?? a.zone,
    location: a.location,
    locationType: a.locationType,
    workingDays: a.workingDays,
    openingMinute: a.open,
    closingMinute: a.close,
    latitude: NETWORK_CENTER.lat + a.pos[1] / 111,
    longitude: NETWORK_CENTER.lng + a.pos[0] / (111 * cosLat),
    capacity: a.capacity,
    isActive: true,
    closedOnHolidays: ["office", "coworking", "university"].includes(a.locationType),
    activeSinceDay: a.ageDays ? anchorDay - a.ageDays : anchorDay - 400,
  }));

  const quarterShare = ARCHETYPES.map((a) =>
    catIds.map((cid) => {
      const arr = new Array<number>(96).fill(0);
      let sum = 0;
      for (let q = 0; q < 96; q++) {
        const minute = q * 15;
        if (minute < a.open || minute + 15 > a.close) continue;
        const t = (minute + 7.5) / 60;
        let curve = 0.06;
        for (const p of a.peaks) curve += p.w * Math.exp(-((t - p.mu) ** 2) / (2 * p.sigma * p.sigma));
        arr[q] = curve * categoryTimeFactor(cid, t);
        sum += arr[q];
      }
      return sum > 0 ? arr.map((v) => v / sum) : arr;
    }),
  );

  const mixShare = ARCHETYPES.map((a) => {
    const raw = catIds.map((cid) => NETWORK_MIX[cid] * (a.mix[cid] ?? 1));
    const s = raw.reduce((x, y) => x + y, 0);
    return raw.map((v) => v / s);
  });

  // every fridge has its own taste in dishes: a random spread plus two clear favourites
  const productWeight = ARCHETYPES.map(() => {
    const w = products.map((_, pi) => PRODUCT_DEFS[pi].popularity * (0.45 + rng() * 1.3));
    for (let k = 0; k < 2; k++) w[Math.floor(rng() * products.length)] *= 2.2;
    return w;
  });

  return {
    seed,
    anchorDay,
    archetypes: ARCHETYPES,
    fridges,
    products,
    quarterShare,
    mixShare,
    productWeight,
    catProducts,
    holidays: holidayDays(anchorDay - 400, anchorDay + 400),
    travel: buildTravelMatrix(fridges),
  };
}

export function isOpenDay(model: SimModel, f: number, day: number): boolean {
  const fr = model.fridges[f];
  if (day < fr.activeSinceDay) return false;
  if (fr.closedOnHolidays && model.holidays.has(day)) return false;
  return fr.workingDays.includes(weekdayOf(day));
}

/** Expected (noise-free) daily demand of a category. */
export function expectedDaily(model: SimModel, f: number, c: number, day: number): number {
  const a = model.archetypes[f];
  const wd = weekdayOf(day);
  const dayOfYear = Math.floor((day * DAY_MS - Date.UTC(new Date(day * DAY_MS).getUTCFullYear(), 0, 1)) / DAY_MS);
  const season = 1 + 0.06 * Math.sin((2 * Math.PI * (dayOfYear - 80)) / 365);
  const dom = dayOfMonth(day);
  const month = dom <= 3 ? 1.06 : dom >= daysInMonth(day) - 2 ? 0.95 : 1;
  const cid = CATEGORIES[c].id;
  const tr = a.trend[cid] ?? 0;
  const progress = Math.min(1, Math.max(0, (day - (model.anchorDay - 180)) / 180));
  const trend = 1 + tr * progress;
  // young fridge ramps up during the first two weeks
  const age = day - model.fridges[f].activeSinceDay;
  const ramp = age < 14 ? 0.6 + 0.4 * (age / 14) : 1;
  return a.baseDaily * (a.weekday[wd] ?? 1) * season * month * trend * ramp * model.mixShare[f][c];
}

export function dayRng(model: SimModel, f: number, day: number, salt = 0): Rng {
  return mulberry32(hashSeed(model.seed, f, day, salt));
}

/**
 * Generates one synthetic historic day for a fridge.
 * outHourly: length C*24, outProduct: length P (both are overwritten).
 */
export function generateDay(model: SimModel, f: number, day: number, outHourly: Float32Array, outProduct: Float32Array): void {
  outHourly.fill(0);
  outProduct.fill(0);
  if (!isOpenDay(model, f, day)) return;
  const rng = dayRng(model, f, day, 1);
  const dayNoise = lognormal(rng, 0.13);
  for (let c = 0; c < C; c++) {
    const daily = expectedDaily(model, f, c, day) * dayNoise * lognormal(rng, 0.08);
    const shares = model.quarterShare[f][c];
    let catTotal = 0;
    for (let hr = 0; hr < 24; hr++) {
      const lambda = daily * (shares[hr * 4] + shares[hr * 4 + 1] + shares[hr * 4 + 2] + shares[hr * 4 + 3]);
      if (lambda <= 0) continue;
      const n = poisson(rng, lambda);
      outHourly[c * 24 + hr] = n;
      catTotal += n;
    }
    const prods = model.catProducts[c];
    const weights = prods.map((p) => model.productWeight[f][p]);
    for (let u = 0; u < catTotal; u++) {
      const k = pickWeighted(rng, weights);
      outProduct[prods[k]] += 1;
    }
  }
}

export interface RecordedDay {
  hourly: number[]; // F*C*24
  product: number[]; // F*P
}

/**
 * History cube for [endDayExclusive - days, endDayExclusive).
 * Days actually played in the simulator (recorded) override synthetic ones.
 */
export function buildHistoryCube(
  model: SimModel,
  endDayExclusive: number,
  days: number,
  recorded: Record<string, RecordedDay>,
): HistoryCube {
  const F = model.fridges.length;
  const P = model.products.length;
  const startDay = endDayExclusive - days;
  const hourly = new Float32Array(F * C * days * 24);
  const productDaily = new Float32Array(F * P * days);
  const tmpH = new Float32Array(C * 24);
  const tmpP = new Float32Array(P);
  for (let d = 0; d < days; d++) {
    const day = startDay + d;
    const rec = recorded[String(day)];
    for (let f = 0; f < F; f++) {
      if (rec) {
        for (let c = 0; c < C; c++)
          for (let hr = 0; hr < 24; hr++) tmpH[c * 24 + hr] = rec.hourly[(f * C + c) * 24 + hr];
        for (let p = 0; p < P; p++) tmpP[p] = rec.product[f * P + p];
      } else {
        generateDay(model, f, day, tmpH, tmpP);
      }
      for (let c = 0; c < C; c++) {
        const base = ((f * C + c) * days + d) * 24;
        for (let hr = 0; hr < 24; hr++) hourly[base + hr] = tmpH[c * 24 + hr];
      }
      for (let p = 0; p < P; p++) productDaily[(f * P + p) * days + d] = tmpP[p];
    }
  }
  const holidays = [...model.holidays].filter((d) => d >= startDay && d < endDayExclusive);
  return { startDay, days, hourly, productDaily, holidays };
}
