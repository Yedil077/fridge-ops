import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { analyzeCards, analyzeNames, buildUnusedProductsXlsx, sanityCheck, type ReportInput, type SalesWindow } from "../src/lib/reports/unusedProducts";

/** Conservative "что можно удалить" report: every case from the spec. Synthetic data — no KiT Shop call. */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 13, 12, 0);
const p = (id: string, name: string) => ({ productId: id, name, barcode: `460${id}`, vendorCode: null, price: 1000 });

/** 13 windows of 14 days, newest first; sales[i] = { id: qty } in window i (window 12 ≈ 6 months ago) */
function windows(sales: Record<number, Record<string, number>>): SalesWindow[] {
  return Array.from({ length: 13 }, (_, i) => {
    const to = NOW - i * 14 * DAY;
    return { from: to - 14 * DAY + 1000, to, qty: new Map(Object.entries(sales[i] ?? {})) };
  });
}

function input(over: Partial<ReportInput> = {}): ReportInput {
  const everyWindow = (id: string, q: number) => Object.fromEntries(Array.from({ length: 13 }, (_, i) => [i, { [id]: q }]));
  const sales: Record<number, Record<string, number>> = everyWindow("200", 30); // «Хит» sells for 6 months → proves age for ids ≤ 200
  const add = (i: number, id: string, q: number) => (sales[i] = { ...(sales[i] ?? {}), [id]: q });
  add(0, "150", 40); // Английский завтрак (active card)
  add(10, "150", 5);
  add(0, "120", 60); // Бризоль с пюре
  add(11, "120", 50);
  add(8, "121", 3); // Бризоль с гречкой: last sale ~4 months ago
  add(0, "130", 12); // Каркаде 500 мл
  add(12, "130", 10);
  return {
    generatedAt: NOW,
    dataReadAt: NOW,
    products: [
      p("200", "Хит"),
      p("100", "Английский завтрак"), // old dead card
      p("150", "Английский завтрак"), // active card
      p("120", "Бризоль из телятины с пюре"),
      p("121", "Бризоль из телятины с гречкой"),
      p("130", "Каркаде с апельсиновым соком 500мл"),
      p("131", "Каркаде с апельсиновым соком 330мл"),
      p("50", "Старый товар"),
      p("60", "Без продаж, но загружали"),
      p("70", "Без продаж, но есть остаток"),
      p("300", "Expanentu"), // new card, loaded 10 days ago, no sales yet
      p("301", "Совсем новый без активности"),
    ],
    salesWindows: windows(sales),
    stocks: new Map([["70", { qty: 3, shops: 1 }]]),
    shopsChecked: 16,
    fillUps: [
      { at: NOW - 10 * DAY, type: 1, notes: null, shopId: "621583", lines: [{ productId: "300", qty: 6 }] },
      { at: NOW - 20 * DAY, type: 1, notes: null, shopId: "621583", lines: [{ productId: "60", qty: 4 }] },
    ],
    fillUpDays: 60,
    fillUpsTotal: 2,
    complete: { products: true, sales: true, stocks: true, fillUps: true },
    endpoints: [{ endpoint: "GetProducts", ok: 1, failed: 0, note: "" }],
    environment: "test",
    ...over,
  };
}

const byName = (inp = input()) => new Map(analyzeNames(inp).map((r) => [r.name, r]));
const byId = (inp = input()) => new Map(analyzeCards(inp).map((r) => [r.product.productId, r]));

test("Expanentu (new, loaded 10 days ago, 0 sales) → НОВЫЙ, never УДАЛИТЬ", () => {
  const r = byName().get("Expanentu")!;
  assert.equal(r.status, "НОВЫЙ");
  assert.match(r.why, /Первое появление 03\.10\.2026, прошло 10 дн\./);
});

test("new card without any activity → НОВЫЙ", () => {
  assert.equal(byName().get("Совсем новый без активности")!.status, "НОВЫЙ");
});

test("Английский завтрак with one active card → whole name ОСТАВИТЬ", () => {
  const r = byName().get("Английский завтрак")!;
  assert.equal(r.status, "ОСТАВИТЬ");
  assert.equal(r.cards.length, 2);
  assert.equal(byId().get("100")!.status, "УДАЛИТЬ", "the dead card alone would be deletable — the name still stays");
});

test("Бризоль with recent sales → ОСТАВИТЬ; a different garnish is a different dish", () => {
  const n = byName();
  assert.equal(n.get("Бризоль из телятины с пюре")!.status, "ОСТАВИТЬ");
  assert.equal(n.get("Бризоль из телятины с гречкой")!.status, "УДАЛИТЬ");
});

test("Каркаде 500 мл with recent sales → ОСТАВИТЬ; 330 мл is a different dish", () => {
  const n = byName();
  assert.equal(n.get("Каркаде с апельсиновым соком 500мл")!.status, "ОСТАВИТЬ");
  assert.equal(n.get("Каркаде с апельсиновым соком 330мл")!.status, "УДАЛИТЬ");
});

test("old item without sales, loads and stock for 60+ days → УДАЛИТЬ (HIGH)", () => {
  const r = byName().get("Старый товар")!;
  assert.equal(r.status, "УДАЛИТЬ");
  assert.equal(r.confidence, "HIGH");
  assert.match(r.why, /продаж 0, загрузок 0, снятий 0, остаток 0/);
});

test("no sales but loaded recently → ОСТАВИТЬ; no sales but stock → ОСТАВИТЬ", () => {
  const n = byName();
  assert.equal(n.get("Без продаж, но загружали")!.status, "ОСТАВИТЬ");
  assert.equal(n.get("Без продаж, но есть остаток")!.status, "ОСТАВИТЬ");
});

test("incomplete API data → НЕ ХВАТАЕТ ДАННЫХ / МОЖНО ПРОВЕРИТЬ, never УДАЛИТЬ", () => {
  const noSales = byName(input({ complete: { products: true, sales: false, stocks: true, fillUps: true } }));
  assert.equal(noSales.get("Старый товар")!.status, "НЕ ХВАТАЕТ ДАННЫХ");
  const noFillUps = byName(input({ complete: { products: true, sales: true, stocks: true, fillUps: false } }));
  assert.equal(noFillUps.get("Старый товар")!.status, "МОЖНО ПРОВЕРИТЬ");
  for (const n of [noSales, noFillUps]) assert.ok(![...n.values()].some((r) => r.status === "УДАЛИТЬ"));
});

test("sanity check: no «ТОЧНО УДАЛИТЬ» row with sales/loads/stock/new/active twin; a forged one is caught", () => {
  const rows = analyzeNames(input());
  assert.deepEqual(sanityCheck(rows), []);
  for (const r of rows.filter((x) => x.status === "УДАЛИТЬ")) {
    assert.equal(r.sold60, 0);
    assert.equal(r.loaded60, 0);
    assert.equal(r.stockNow, 0);
    assert.notEqual(r.name, "Expanentu");
    assert.notEqual(r.name, "Английский завтрак");
  }
  const forged = rows.map((r) => (r.name === "Expanentu" ? { ...r, status: "УДАЛИТЬ" as const } : r));
  assert.ok(sanityCheck(forged).length > 0);
  assert.throws(() => buildUnusedProductsXlsx(input(), forged), /Проверка перед выдачей не пройдена/);
});

test("Excel: 6 sheets in the agreed order", () => {
  const bytes = buildUnusedProductsXlsx(input());
  assert.equal(Buffer.from(bytes.slice(0, 2)).toString(), "PK");
  const text = Buffer.from(bytes).toString("utf8");
  const order = ["ТОЧНО УДАЛИТЬ", "ПРОВЕРИТЬ", "ОСТАВИТЬ", "НОВЫЕ", "ВСЕ ТОВАРЫ", "КАК СЧИТАЛИ"].map((n) => text.indexOf(`name="${n}"`));
  assert.ok(order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]), String(order));
  if (process.env.XLSX_OUT) fs.writeFileSync(process.env.XLSX_OUT, bytes);
});
