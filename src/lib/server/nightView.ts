import "server-only";
import type { NetworkSnapshot } from "../domain/types";
import { CATEGORY_IDS } from "../domain/categories";
import { analyseBatches } from "../engine/batches";
import { BIZ_GROUPS, planNight, type BizGroup, type NightFridge, type NightLot, type NightNew, type NightRole } from "../engine/night";
import { shelfHoursFor, type ShelfLifeSettings } from "../config/shelfLife";
import { dayNumber, minuteOfDay } from "../time";
import type { KitShopLive } from "./kitshopLive";

/**
 * НОЧЬ — the night driver's task for one delivery date (engine/night.ts) from what we know right now:
 *   · the kitchen's table of new product (night_plan, imported from Google Sheets — read only, never changed);
 *   · what stands in every fridge now and since when (KiT Shop stock + loads, oldest sold first);
 *   · how much of each group every fridge usually sells on that weekday (the nightly analytics).
 * At 17:00 / 19:00 it is a draft (the rest of today's sales are still to come); the final one is at ~00:30.
 */

const DAY = 86_400_000;
const H = 3_600_000;
/** the night route starts at 01:00 of the delivery date */
export const NIGHT_START_HOUR = 1;

const BUILDING: Record<string, string> = {
  SHARIPOVA: "ДОСМУХАМЕДОВА",
  DOSMUKHAMEDOVA: "ДОСМУХАМЕДОВА",
  SATTI: "САТТИ",
  KABLAN_KANKORD: "КАБЛАН-КОНКОРД",
  ZHIBEK_ZHOLY: "ЖИБЕК ЖОЛЫ",
  NAZARBAYEVA: "ЗАММЛЕР",
};
/** moves between buildings the night route makes (the manager's own route sheet) */
export const NIGHT_ROUTES: [string, string][] = [
  ["ДОСМУХАМЕДОВА", "КАБЛАН-КОНКОРД"],
  ["ЖИБЕК ЖОЛЫ", "КАБЛАН-КОНКОРД"],
  ["ЖИБЕК ЖОЛЫ", "САТТИ"],
  ["ЗАММЛЕР", "КАБЛАН-КОНКОРД"],
  ["ЗАММЛЕР", "САТТИ"],
];
const ROLE: Record<string, NightRole> = { ZHIBEK_ZHOLY: "low", NAZARBAYEVA: "isolated" };
const GROUP_OF_CATEGORY: Record<string, BizGroup> = { breakfast: "Завтраки", hot: "Горячее", salad: "Салаты", snack: "Перекусы", dessert: "Десерты", drink: "Напитки" };

/** "Завтрак КП" → Завтраки, "Перекус ПП" → Перекусы, … (the kitchen table's group rows) */
export function bizGroupOf(label: string): BizGroup {
  const s = label.toLowerCase();
  if (s.startsWith("завтрак")) return "Завтраки";
  if (s.startsWith("перекус")) return "Перекусы";
  if (s.startsWith("горяч")) return "Горячее";
  if (s.startsWith("салат")) return "Салаты";
  if (s.startsWith("десерт")) return "Десерты";
  if (s.startsWith("напит")) return "Напитки";
  return (BIZ_GROUPS as string[]).includes(label) ? (label as BizGroup) : "Другое";
}

const iso = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);

/** The delivery date shown by default: from noon on — tonight's (tomorrow's date), before noon — last night's. */
export function defaultNightDay(now: number) {
  return dayNumber(now) + (minuteOfDay(now) >= 12 * 60 ? 1 : 0);
}

export async function nightView(live: KitShopLive, snap: NetworkSnapshot, shelfLife: ShelfLifeSettings, dateIso: string | null) {
  const day = dateIso && /^\d{4}-\d{2}-\d{2}$/.test(dateIso) ? Math.floor(Date.parse(`${dateIso}T00:00:00Z`) / DAY) : defaultNightDay(snap.now);
  const date = iso(day);
  const start = day * DAY + NIGHT_START_HOUR * H;
  const at = Math.max(start, snap.now);
  const plan = await live.repo.getNightPlan(date);
  const cache = live.analytics;

  // the kitchen's new product per fridge (as is)
  const planBy = new Map<string, NightNew[]>();
  for (const r of plan?.rows ?? []) {
    if (r.qty <= 0) continue;
    const list = planBy.get(r.shopId) ?? [];
    list.push({ productId: r.productId, name: r.name, group: bizGroupOf(r.group), qty: r.qty });
    planBy.set(r.shopId, list);
  }
  const planned = (shopId: string) => (planBy.get(shopId) ?? []).reduce((a, n) => a + n.qty, 0);

  const fridges: NightFridge[] = snap.fridges.map((f) => ({
    shopId: f.externalId,
    name: f.shortName ?? f.name,
    building: BUILDING[f.transferGroup ?? ""] ?? f.transferGroup ?? f.name,
    // a fridge the kitchen sends nothing to that night is closed: everything good leaves it
    role: plan && planned(f.externalId) === 0 ? "closed" : (ROLE[f.transferGroup ?? ""] ?? "normal"),
  }));

  // what stands in every fridge and since when (oldest sold first)
  const P = snap.products.length;
  const stock = new Map<string, NightLot[]>();
  snap.fridges.forEach((f, fi) => {
    const lots: NightLot[] = [];
    snap.products.forEach((p, pi) => {
      const qty = snap.stock[fi * P + pi];
      if (qty <= 0) return;
      const shelf = shelfHoursFor(shelfLife, p.id, p.categoryId).hours;
      const events = snap.productDays?.recent[fi * P + pi];
      const base = { productId: p.externalId, name: p.name, group: GROUP_OF_CATEGORY[p.categoryId] ?? "Другое", shelfHours: shelf };
      if (!events || !snap.productDays) {
        lots.push({ ...base, qty, loadedAt: null });
        return;
      }
      const r = analyseBatches({ events, from: snap.productDays.recentFrom, now: snap.now, currentStock: qty, shelfHours: shelf });
      for (const l of r.lots) if (l.left > 0) lots.push({ ...base, qty: Math.round(l.left), loadedAt: l.at });
    });
    stock.set(f.externalId, lots);
  });

  // usual units of a group on this weekday: the same weekday of the last 6 weeks, open days, holidays left out
  const demandCache = new Map<string, number | null>();
  const demand = (shopId: string, g: BizGroup): number | null => {
    if (!plan) return null;
    const key = `${shopId}|${g}`;
    if (demandCache.has(key)) return demandCache.get(key)!;
    let v: number | null = null;
    const sh = cache?.shops.get(shopId);
    const c = CATEGORY_IDS.findIndex((id) => GROUP_OF_CATEGORY[id] === g);
    if (cache && sh && c >= 0) {
      const days = [1, 2, 3, 4, 5, 6].map((w) => day - 7 * w - cache.startDay).filter((d) => d >= 0 && d < cache.days);
      const rec = days.map((d) => sh.receiptsByDay[d] ?? 0);
      const usual = [...rec].filter((x) => x > 0).sort((a, b) => a - b);
      const med = usual.length ? usual[Math.floor(usual.length / 2)] : 0;
      const units = days
        .filter((_, i) => rec[i] > 0 && rec[i] >= med / 2)
        .map((d) => {
          let s = 0;
          for (let h = 0; h < 24; h++) s += sh.cube[((c * cache.days + d) * 24) + h];
          return s;
        })
        .sort((a, b) => a - b);
      if (units.length >= 2) v = Math.round(units[Math.floor(units.length / 2)]);
    }
    demandCache.set(key, v);
    return v;
  };

  const stops = planNight({ at, fridges, stock, plan: planBy, demand, routes: NIGHT_ROUTES });

  // route order: buildings that give most first (pick up before dropping off), then fridges with pick-ups first
  const net = new Map<string, number>();
  for (const s of stops) net.set(s.building, (net.get(s.building) ?? 0) + s.take.reduce((a, m) => a + m.qty, 0) - s.put.reduce((a, m) => a + m.qty, 0));
  stops.sort((a, b) => (net.get(b.building) ?? 0) - (net.get(a.building) ?? 0) || a.building.localeCompare(b.building, "ru") || b.take.length - a.take.length || a.name.localeCompare(b.name, "ru"));

  const sum = (pick: (s: (typeof stops)[number]) => { qty: number }[]) => stops.reduce((a, s) => a + pick(s).reduce((x, l) => x + l.qty, 0), 0);
  const stockAt = Math.max(0, ...[...live.ds.stockAt.values()]);
  return {
    date,
    day,
    now: snap.now,
    at,
    start,
    /** before ~3 h to the route the rest of today's sales are still ahead */
    draft: snap.now < start - 3 * H,
    stockAt: stockAt || null,
    plan: plan ? { source: plan.source, importedAt: plan.importedAt, importedBy: plan.importedBy, rows: plan.rows.length, units: plan.rows.reduce((a, r) => a + r.qty, 0) } : null,
    analysisAt: cache?.runAt ?? null,
    totals: { writeOff: sum((s) => s.writeOff), moved: sum((s) => s.take), toBase: sum((s) => s.toBase), fresh: sum((s) => s.putNew) },
    stops,
  };
}

export type NightView = Awaited<ReturnType<typeof nightView>>;
