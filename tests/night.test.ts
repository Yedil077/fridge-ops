import { test } from "node:test";
import assert from "node:assert/strict";
import { planNight, type BizGroup, type NightFridge, type NightLot, type NightNew } from "../src/lib/engine/night";

/**
 * НОЧНОЕ ЗАДАНИЕ: the kitchen's new product is given and never changed; the app decides what happens to what already
 * stands in the fridges — write off, keep, move (the same building first, old units only to strong points), to the base.
 */

const H = 3_600_000;
const AT = 1_000 * H;
const lot = (productId: string, name: string, group: BizGroup, qty: number, hoursAgo: number | null, shelfHours = 48): NightLot => ({
  productId,
  name,
  group,
  qty,
  shelfHours,
  loadedAt: hoursAgo === null ? null : AT - hoursAgo * H,
});
const fresh = (group: BizGroup, qty: number): NightNew => ({ productId: null, name: `новое ${group}`, group, qty });

const fridges: NightFridge[] = [
  { shopId: "S2", name: "Сатти 2", building: "САТТИ", role: "normal" },
  { shopId: "S1", name: "Сатти 1", building: "САТТИ", role: "normal" },
  { shopId: "SH", name: "Шарипова", building: "ДОСМУХАМЕДОВА", role: "closed" },
  { shopId: "K3", name: "Каблан 3", building: "КАБЛАН-КОНКОРД", role: "normal" },
  { shopId: "ZH", name: "Жибек Жолы", building: "ЖИБЕК", role: "low" },
  { shopId: "ZM", name: "Заммлер", building: "ЗАММЛЕР", role: "isolated" },
];
const demand: Record<string, Partial<Record<BizGroup, number>>> = {
  S2: { Салаты: 4, Горячее: 6 },
  S1: { Салаты: 8, Горячее: 10 },
  SH: { Салаты: 2, Горячее: 3 },
  K3: { Салаты: 9, Горячее: 12 },
  ZH: { Салаты: 2, Горячее: 2 },
  ZM: { Салаты: 3, Горячее: 3 },
};

function run() {
  return planNight({
    at: AT,
    fridges,
    stock: new Map([
      ["S2", [lot("c", "Цезарь", "Салаты", 4, 20), lot("p", "Шарлотка", "Десерты", 1, 75, 72)]],
      ["SH", [lot("h", "Шницель", "Горячее", 3, 10), lot("g", "Гуляш", "Горячее", 2, 40)]],
      ["ZH", [lot("v", "Винегрет", "Салаты", 2, 30)]],
      ["ZM", [lot("o", "Оливье", "Салаты", 2, 5)]],
    ]),
    plan: new Map([
      ["S2", [fresh("Салаты", 3), fresh("Горячее", 6)]],
      ["S1", [fresh("Салаты", 3), fresh("Горячее", 6)]],
      ["K3", [fresh("Салаты", 5), fresh("Горячее", 6)]],
      ["ZH", [fresh("Салаты", 2)]],
      ["ZM", [fresh("Салаты", 3)]],
    ]),
    demand: (s, g) => demand[s]?.[g] ?? null,
    routes: [
      ["ДОСМУХАМЕДОВА", "КАБЛАН-КОНКОРД"],
      ["ЖИБЕК", "КАБЛАН-КОНКОРД"],
      ["ЖИБЕК", "САТТИ"],
      ["ЗАММЛЕР", "САТТИ"],
    ],
  });
}
const stop = (id: string) => run().find((s) => s.shopId === id)!;

test("expired → written off, never moved", () => {
  const s = stop("S2");
  assert.deepEqual(s.writeOff.map((l) => [l.name, l.qty]), [["Шарлотка", 1]]);
  assert.ok(!run().some((x) => x.put.some((p) => p.name === "Шарлотка")));
});

test("the new delivery is the kitchen's table as is", () => {
  assert.deepEqual(stop("S1").putNew.map((n) => [n.group, n.qty]), [["Салаты", 3], ["Горячее", 6]]);
});

test("extra in one fridge goes to the same building first: Сатти 2 keeps 1 Цезарь (4 − 3 new), 3 go to Сатти 1", () => {
  const s2 = stop("S2");
  assert.equal(s2.keep.filter((l) => l.name === "Цезарь").reduce((a, l) => a + l.qty, 0), 1);
  assert.deepEqual(s2.take.map((m) => [m.name, m.qty, m.to]), [["Цезарь", 3, "S1"]]);
  assert.deepEqual(stop("S1").put.filter((m) => m.from === "S2").map((m) => [m.name, m.qty]), [["Цезарь", 3]]);
});

test("a closed fridge is emptied: fresh units go by an allowed route, too-old units go to the base (manager)", () => {
  const sh = stop("SH");
  assert.deepEqual(sh.take.map((m) => [m.name, m.qty, m.to]), [["Шницель", 3, "K3"]]);
  assert.deepEqual(sh.toBase.map((l) => [l.name, l.qty]), [["Гуляш", 2]], "40 h of 48 — too late to drive around");
  assert.equal(sh.keep.length, 0);
});

test("old units only to a strong fridge; isolated Заммлер never receives; nothing exceeds a receiver's room", () => {
  const zh = stop("ZH");
  // Винегрет is 30 h old (> half its shelf) and Жибек has no room (2 − 2 new) → only Каблан 3 / Сатти 1 qualify
  assert.equal(zh.take.length, 1);
  assert.ok(["K3", "S1"].includes(zh.take[0].to));
  for (const s of run()) {
    if (s.role === "isolated") assert.equal(s.put.length, 0);
    for (const g of s.groups) if (g.demand !== null && g.received > 0) assert.ok(g.after <= Math.max(g.demand, g.fresh + g.kept + g.received) && g.kept + g.received + g.fresh <= g.demand, `${s.name} ${g.group}`);
  }
});

test("units sum up: every good unit is kept, moved or sent to the base exactly once", () => {
  const all = run();
  const moved = all.reduce((a, s) => a + s.take.reduce((x, m) => x + m.qty, 0), 0);
  const put = all.reduce((a, s) => a + s.put.reduce((x, m) => x + m.qty, 0), 0);
  assert.equal(moved, put);
  const kept = all.reduce((a, s) => a + s.keep.reduce((x, m) => x + m.qty, 0), 0);
  const base = all.reduce((a, s) => a + s.toBase.reduce((x, m) => x + m.qty, 0), 0);
  const wo = all.reduce((a, s) => a + s.writeOff.reduce((x, m) => x + m.qty, 0), 0);
  assert.equal(kept + moved + base + wo, 4 + 1 + 3 + 2 + 2 + 2);
});
