import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { analyzeProducts, buildUnusedProductsXlsx, type ReportInput, type SalesWindow } from "../src/lib/reports/unusedProducts";

/** "Неиспользуемые блюда": decision rules and a valid Excel file. Data is synthetic — no KiT Shop call. */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 9, 12, 0);
const p = (id: string, name: string) => ({ productId: id, name, barcode: `460${id}`, vendorCode: null, price: 1000 });

function windows(sales: Record<number, Record<string, number>>): SalesWindow[] {
  // 13 windows of 14 days, newest first; sales[i] = sales in window i
  return Array.from({ length: 13 }, (_, i) => {
    const to = NOW - i * 14 * DAY;
    return { from: to - 14 * DAY + 1000, to, qty: new Map(Object.entries(sales[i] ?? {})) };
  });
}

function input(): ReportInput {
  return {
    generatedAt: NOW,
    products: [p("1", "Никогда не продавался"), p("2", "Продавался полгода назад"), p("3", "Лежит без продаж"), p("4", "Много снятий"), p("5", "Хит продаж"), p("6", "Затих 30 дней")],
    salesWindows: windows({ 0: { "5": 40, "4": 2 }, 1: { "5": 38 }, 3: { "6": 5 }, 8: { "2": 3 } }),
    stocks: new Map([
      ["3", { qty: 4, shops: 2 }],
      ["5", { qty: 10, shops: 6 }],
    ]),
    shopsChecked: 15,
    fillUps: [
      { at: NOW - 3 * DAY, type: 1, notes: null, shopId: "621583", lines: [{ productId: "4", qty: 10 }, { productId: "5", qty: 20 }] },
      { at: NOW - 1 * DAY, type: 2, notes: "СПИСАНИЕ: истёк срок", shopId: "621583", lines: [{ productId: "4", qty: -6 }] },
    ],
    fillUpDays: 30,
    fillUpsTotal: 2,
    fillUpsCapped: false,
    environment: "test",
  };
}

test("decision rules: delete / check / keep with a plain reason", () => {
  const rows = new Map(analyzeProducts(input()).map((r) => [r.product.productId, r]));
  assert.equal(rows.get("1")!.recommendation, "УДАЛИТЬ");
  assert.match(rows.get("1")!.reason, /Не продавался 18\d\+ дней/);
  assert.equal(rows.get("2")!.recommendation, "УДАЛИТЬ");
  assert.ok(rows.get("2")!.daysWithoutSales! >= 98, "last sale ~100+ days ago");
  assert.equal(rows.get("3")!.recommendation, "ПРОВЕРИТЬ");
  assert.match(rows.get("3")!.reason, /Лежит в 2 холодильн/);
  assert.equal(rows.get("4")!.recommendation, "ПРОВЕРИТЬ");
  assert.match(rows.get("4")!.reason, /снято 60%.*«списание» 6/);
  assert.equal(rows.get("4")!.writeOffTagged, 6);
  assert.equal(rows.get("5")!.recommendation, "ОСТАВИТЬ");
  assert.equal(rows.get("5")!.sold30, 78);
  assert.equal(rows.get("6")!.recommendation, "ПРОВЕРИТЬ");
  assert.match(rows.get("6")!.reason, /последние 30 дней/);
});

test("delete rows come first, most stale first", () => {
  const order = analyzeProducts(input()).map((r) => r.recommendation);
  assert.deepEqual(order.slice(0, 2), ["УДАЛИТЬ", "УДАЛИТЬ"]);
  assert.equal(order.at(-1), "ОСТАВИТЬ");
});

test("the Excel file is a valid xlsx with 3 sheets", () => {
  const bytes = buildUnusedProductsXlsx(input());
  assert.equal(Buffer.from(bytes.slice(0, 2)).toString(), "PK");
  const text = Buffer.from(bytes).toString("utf8");
  for (const part of ["xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet3.xml", "Для менеджеров", "Как считали", "Никогда не продавался"]) assert.ok(text.includes(part), part);
  if (process.env.XLSX_OUT) fs.writeFileSync(process.env.XLSX_OUT, bytes);
});
