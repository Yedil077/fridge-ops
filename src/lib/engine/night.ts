/**
 * НОЧНОЕ ЗАДАНИЕ — what the night driver does at every fridge before the new delivery (≈01:00).
 *
 * The plan of NEW product per fridge × dish comes from the kitchen's table (Google Sheets) and is never changed here.
 * Apps Холодосов only decides what happens to what is already in the fridges:
 *   СПИСАТЬ   — the shelf life is over (a write-off, never moved);
 *   ОСТАВИТЬ  — still good and this fridge sells it (with the new delivery) within its group's daily demand;
 *   ВЫГРУЗИТЬ → to another fridge where that group will be short (the same building first, then the allowed routes);
 *               older units only to fridges with strong demand; too old units are never driven around;
 *   НА БАЗУ   — good, too much here, no fridge needs it: the manager decides.
 * Every number is whole units; every decision carries its reason.
 */

const H = 3_600_000;

export type BizGroup = "Завтраки" | "Перекусы" | "Горячее" | "Салаты" | "Десерты" | "Напитки" | "Другое";
export const BIZ_GROUPS: BizGroup[] = ["Завтраки", "Перекусы", "Горячее", "Салаты", "Десерты", "Напитки", "Другое"];

/** normal — main points; low — weak (Жибек Жолы): never a receiver of old units; isolated — Заммлер: never a receiver; closed — everything out */
export type NightRole = "normal" | "low" | "isolated" | "closed";

export interface NightFridge {
  shopId: string;
  name: string;
  /** fridges in one building are a free move ("САТТИ", "КАБЛАН-КОНКОРД", …) */
  building: string;
  role: NightRole;
}

export interface NightLot {
  productId: string;
  name: string;
  group: BizGroup;
  shelfHours: number;
  qty: number;
  /** when it was loaded; null = unknown (treated as old: kept, never moved) */
  loadedAt: number | null;
}

export interface NightNew {
  productId: string | null;
  name: string;
  group: BizGroup;
  qty: number;
}

export interface NightLine {
  productId: string;
  name: string;
  group: BizGroup;
  qty: number;
  ageHours: number | null;
  leftHours: number | null;
  reason: string;
}

export interface NightMove extends NightLine {
  from: string;
  to: string;
}

export interface NightStop {
  shopId: string;
  name: string;
  building: string;
  role: NightRole;
  writeOff: NightLine[];
  take: NightMove[];
  put: NightMove[];
  keep: NightLine[];
  toBase: NightLine[];
  putNew: NightNew[];
  /** per group: demand for the day, what stands after the night, the new delivery */
  groups: { group: BizGroup; demand: number | null; kept: number; received: number; fresh: number; after: number }[];
}

export interface NightInput {
  /** when the route starts (ages are counted to this moment) */
  at: number;
  fridges: NightFridge[];
  stock: Map<string, NightLot[]>;
  /** new product per fridge (the kitchen's table, as is) */
  plan: Map<string, NightNew[]>;
  /** units of a group this fridge usually sells on the delivery day; null = unknown (then nothing is moved in or out of it) */
  demand: (shopId: string, group: BizGroup) => number | null;
  /** extra allowed routes between buildings: from building → to building */
  routes: [string, string][];
  /** a unit older than this share of its shelf life is never moved (default 0.75: 36 h of 48) */
  maxMoveShare?: number;
}

const ageOf = (at: number, l: NightLot) => (l.loadedAt === null ? null : Math.max(0, (at - l.loadedAt) / H));

export function planNight(input: NightInput): NightStop[] {
  const { at } = input;
  const maxShare = input.maxMoveShare ?? 0.75;
  const stops = new Map<string, NightStop>();
  for (const f of input.fridges)
    stops.set(f.shopId, { ...f, writeOff: [], take: [], put: [], keep: [], toBase: [], putNew: [...(input.plan.get(f.shopId) ?? [])], groups: [] });

  // 1) write-offs; the rest is "good" with an age
  type Unit = NightLot & { shopId: string; age: number | null; left: number | null };
  const good: Unit[] = [];
  for (const f of input.fridges) {
    const s = stops.get(f.shopId)!;
    for (const l of input.stock.get(f.shopId) ?? []) {
      if (l.qty <= 0) continue;
      const age = ageOf(at, l);
      const left = age === null ? null : l.shelfHours - age;
      if (left !== null && left <= 0) {
        s.writeOff.push({ productId: l.productId, name: l.name, group: l.group, qty: l.qty, ageHours: Math.round(age!), leftHours: 0, reason: `срок ${l.shelfHours} ч истёк` });
        continue;
      }
      good.push({ ...l, shopId: f.shopId, age, left });
    }
  }

  // 2) per fridge × group: how many of the good units it keeps; the extra is offered to other fridges (oldest movable first)
  const keepIn = new Map<string, number>(); // shop|group → units kept
  const offers: Unit[] = [];
  const supplyNew = (shopId: string, g: BizGroup) => (input.plan.get(shopId) ?? []).filter((n) => n.group === g).reduce((a, n) => a + n.qty, 0);
  for (const f of input.fridges) {
    const mine = good.filter((u) => u.shopId === f.shopId);
    for (const g of BIZ_GROUPS) {
      const units = mine.filter((u) => u.group === g).sort((a, b) => (b.age ?? 1e9) - (a.age ?? 1e9));
      if (!units.length) continue;
      const d = input.demand(f.shopId, g);
      // room for old units = demand − the new delivery; a closed fridge keeps nothing
      let room = f.role === "closed" ? 0 : d === null ? Infinity : Math.max(0, Math.round(d) - supplyNew(f.shopId, g));
      let kept = 0;
      for (const u of units) {
        const movable = u.age !== null && u.left !== null && u.age <= u.shelfHours * maxShare;
        const k = Math.min(u.qty, room === Infinity ? u.qty : room);
        if (k > 0) {
          kept += k;
          if (room !== Infinity) room -= k;
        }
        const rest = u.qty - k;
        if (k > 0) stops.get(f.shopId)!.keep.push(line(u, k, d === null ? "продаж этой группы по дням недели нет — не трогаем" : "успеет продаться здесь вместе с новой поставкой"));
        if (rest <= 0) continue;
        if (movable) offers.push({ ...u, qty: rest });
        else if (f.role === "closed") stops.get(f.shopId)!.toBase.push(line(u, rest, u.age === null ? "возраст неизвестен, точка закрыта — решает менеджер" : `стоит ${Math.round(u.age)} ч — возить поздно, точка закрыта — решает менеджер`));
        else stops.get(f.shopId)!.keep.push(line(u, rest, u.age === null ? "возраст неизвестен — не возим" : `стоит ${Math.round(u.age)} ч из ${u.shelfHours} — возить поздно, остаётся до конца срока`));
      }
      keepIn.set(`${f.shopId}|${g}`, kept);
    }
  }

  // 3) receivers: room = demand − new delivery − what they keep; the same building first, then the allowed routes
  const received = new Map<string, number>();
  const roomOf = (shopId: string, g: BizGroup) => {
    const d = input.demand(shopId, g);
    if (d === null) return 0;
    return Math.max(0, Math.round(d) - supplyNew(shopId, g) - (keepIn.get(`${shopId}|${g}`) ?? 0) - (received.get(`${shopId}|${g}`) ?? 0));
  };
  const fr = new Map(input.fridges.map((f) => [f.shopId, f]));
  const allowed = new Set(input.routes.map(([a, b]) => `${a}→${b}`));
  const cost = (from: NightFridge, to: NightFridge) => (from.building === to.building ? 0 : allowed.has(`${from.building}→${to.building}`) ? 1 : null);
  // strongest demand of a group in the network: old units only go to fridges in the upper half
  const strong = (g: BizGroup) => {
    const xs = input.fridges.map((f) => input.demand(f.shopId, g)).filter((x): x is number => x !== null).sort((a, b) => a - b);
    return xs.length ? xs[Math.floor(xs.length / 2)] : 0;
  };

  offers.sort((a, b) => (b.age ?? 0) - (a.age ?? 0));
  for (const u of offers) {
    const from = fr.get(u.shopId)!;
    let left = u.qty;
    const old = u.age !== null && u.age > u.shelfHours / 2;
    while (left > 0) {
      let best: { f: NightFridge; c: number; room: number } | null = null;
      for (const to of input.fridges) {
        if (to.shopId === from.shopId || to.role === "isolated" || to.role === "closed") continue;
        if (old && (to.role === "low" || (input.demand(to.shopId, u.group) ?? 0) < strong(u.group))) continue;
        const c = cost(from, to);
        if (c === null) continue;
        const room = roomOf(to.shopId, u.group);
        if (room <= 0) continue;
        if (!best || c < best.c || (c === best.c && room > best.room)) best = { f: to, c, room };
      }
      if (!best) break;
      const q = Math.min(left, best.room);
      const why = `${from.role === "closed" ? "точка закрыта" : "здесь лишнее"}; в «${best.f.name}» ${u.group.toLowerCase()} не хватит ещё ~${best.room} шт.${old ? " (старый товар — только в сильную точку)" : ""}`;
      stops.get(from.shopId)!.take.push({ ...line(u, q, why), from: from.shopId, to: best.f.shopId });
      stops.get(best.f.shopId)!.put.push({ ...line(u, q, why), from: from.shopId, to: best.f.shopId });
      received.set(`${best.f.shopId}|${u.group}`, (received.get(`${best.f.shopId}|${u.group}`) ?? 0) + q);
      left -= q;
    }
    if (left > 0) {
      const s = stops.get(from.shopId)!;
      if (from.role === "closed" || (u.left ?? 0) > 12) s.toBase.push(line(u, left, "свежее, но ни одной точке по разрешённым маршрутам не нужно — решает менеджер (на базу)"));
      else s.keep.push(line(u, left, "лишнее, но осталось мало срока — не возим, остаётся"));
    }
  }

  // 4) per group totals after the night
  for (const s of stops.values())
    s.groups = BIZ_GROUPS.map((g) => {
      const kept = s.keep.filter((l) => l.group === g).reduce((a, l) => a + l.qty, 0);
      const rec = s.put.filter((l) => l.group === g).reduce((a, l) => a + l.qty, 0);
      const fresh = s.putNew.filter((n) => n.group === g).reduce((a, n) => a + n.qty, 0);
      return { group: g, demand: input.demand(s.shopId, g), kept, received: rec, fresh, after: kept + rec + fresh };
    }).filter((x) => x.after > 0 || (x.demand ?? 0) > 0);
  return [...stops.values()];
}

function line(u: NightLot & { age: number | null; left: number | null }, qty: number, reason: string): NightLine {
  return {
    productId: u.productId,
    name: u.name,
    group: u.group,
    qty,
    ageHours: u.age === null ? null : Math.round(u.age),
    leftHours: u.left === null ? null : Math.max(0, Math.round(u.left)),
    reason,
  };
}
