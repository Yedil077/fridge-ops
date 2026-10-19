import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeByShop, sanityCheckShops, sheetName, shopSheets, shopSummaries, type ShopReportInput } from "../src/lib/reports/unusedByShop";
import type { NameRow } from "../src/lib/reports/unusedProducts";
import { findProductList } from "../src/services/kitshop/productBase";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 19, 12);

/** company-wide rows: only what the per-point analysis reads (name status, card status, network sales) */
const nameRow = (pid: string, name: string, status: NameRow["status"], sold60: number) =>
  ({ name, status, cards: [{ product: { productId: pid, name }, status, sold60 }] }) as unknown as NameRow;

function input(over: Partial<ShopReportInput> = {}): ShopReportInput {
  return {
    generatedAt: NOW,
    shops: [
      { shopId: "621287", name: "1 Шарипова 4 этаж", templateId: 11 },
      { shopId: "621135", name: "92 Каблан 3 этаж", templateId: 12 },
    ],
    bases: new Map([
      [11, [{ productId: "1", disabled: false }, { productId: "2", disabled: false }, { productId: "3", disabled: false }, { productId: "4", disabled: false }, { productId: "5", disabled: false }]],
      [12, [{ productId: "1", disabled: false }, { productId: "2", disabled: false }]],
    ]),
    products: [
      { productId: "1", name: "Exponenta натуральный", barcode: null, vendorCode: null, price: 900 },
      { productId: "2", name: "Праздничный плов", barcode: null, vendorCode: null, price: 2200 },
      { productId: "3", name: "Каркаде 330мл", barcode: null, vendorCode: null, price: 600 },
      { productId: "4", name: "Новый боул", barcode: null, vendorCode: null, price: 1900 },
      { productId: "5", name: "Сырники", barcode: null, vendorCode: null, price: 1500 },
    ],
    shopSales: {
      coveredFrom: NOW - 180 * DAY,
      complete60: true,
      byShop: new Map([
        ["621135", new Map([["1", { last: NOW - 2 * DAY, qty60: 14, qtyAll: 80 }], ["2", { last: NOW - DAY, qty60: 30, qtyAll: 200 }]])],
        ["621287", new Map([["2", { last: NOW - 3 * DAY, qty60: 9, qtyAll: 60 }], ["1", { last: NOW - 100 * DAY, qty60: 0, qtyAll: 4 }]])],
      ]),
    },
    fillUps: [{ at: NOW - 10 * DAY, type: 1, notes: null, shopId: "621287", lines: [{ productId: "5", qty: 6 }] }],
    fillUpsComplete: true,
    fillUpDays: 60,
    stockByShop: new Map([["621287", new Map([["3", 2]])], ["621135", new Map()]]),
    stockFailedShops: new Set(),
    nameRows: [nameRow("1", "Exponenta натуральный", "ОСТАВИТЬ", 14), nameRow("2", "Праздничный плов", "ОСТАВИТЬ", 39), nameRow("3", "Каркаде 330мл", "ОСТАВИТЬ", 0), nameRow("4", "Новый боул", "НОВЫЙ", 0), nameRow("5", "Сырники", "ОСТАВИТЬ", 0)],
    ...over,
  };
}

const find = (rows: ReturnType<typeof analyzeByShop>, shop: string, pid: string) => rows.find((r) => r.shopId === shop && r.productId === pid)!;

test("per point: sells in Каблан, dead in Шарипова → remove only from Шарипова's base", () => {
  const rows = analyzeByShop(input());
  const sharipova = find(rows, "621287", "1");
  assert.equal(sharipova.status, "УБРАТЬ ИЗ ТОЧКИ");
  assert.match(sharipova.why, /последняя продажа здесь/);
  assert.match(sharipova.why, /В других точках продаётся \(14 шт/);
  assert.equal(find(rows, "621135", "1").status, "ОСТАВИТЬ");
  assert.equal(find(rows, "621287", "2").status, "ОСТАВИТЬ");
});

test("per point: stock, a recent load and a new dish always stay", () => {
  const rows = analyzeByShop(input());
  assert.equal(find(rows, "621287", "3").status, "ОСТАВИТЬ", "lies in the fridge");
  assert.equal(find(rows, "621287", "5").status, "ОСТАВИТЬ", "loaded 10 days ago");
  assert.equal(find(rows, "621287", "4").status, "НОВЫЙ");
  assert.deepEqual(sanityCheckShops(rows, input()), []);
});

test("per point: without complete receipt history nothing is «убрать», only «проверить»", () => {
  for (const shopSales of [null, { ...input().shopSales!, complete60: false }]) {
    const rows = analyzeByShop(input({ shopSales }));
    assert.ok(!rows.some((r) => r.status === "УБРАТЬ ИЗ ТОЧКИ"));
    assert.equal(find(rows, "621287", "1").status, "ПРОВЕРИТЬ");
  }
  const failedStock = analyzeByShop(input({ stockFailedShops: new Set(["621287"]) }));
  assert.equal(find(failedStock, "621287", "1").status, "ПРОВЕРИТЬ");
  const partialFills = analyzeByShop(input({ fillUpsComplete: false }));
  assert.equal(find(partialFills, "621287", "1").status, "ПРОВЕРИТЬ");
});

test("per point: unreadable base → only dishes that left a trace in the point are listed", () => {
  const inp = input({ bases: new Map([[11, null], [12, null]]) });
  const rows = analyzeByShop(inp);
  const sharipova = rows.filter((r) => r.shopId === "621287").map((r) => r.productId).sort();
  assert.deepEqual(sharipova, ["1", "2", "3", "5"], "dish 4 never was in this point → not guessed");
  assert.ok(rows.every((r) => r.inBase === null));
  assert.equal(shopSummaries(rows, inp)[0].baseRead, false);
});

test("Excel: summary + every point gets its own sheet, names valid and unique", () => {
  const inp = input();
  const rows = analyzeByShop(inp);
  const sheets = shopSheets(rows, shopSummaries(rows, inp));
  assert.deepEqual(sheets.slice(0, 3).map((s) => s.name), ["СВОДКА ПО ТОЧКАМ", "УБРАТЬ ПО ТОЧКАМ", "ПРОВЕРИТЬ ПО ТОЧКАМ"]);
  assert.equal(sheets.length, 3 + 2);
  const used = new Set<string>();
  const a = sheetName("Очень длинное название точки: 4/5 этаж [тест]", used);
  const b = sheetName("Очень длинное название точки: 4/5 этаж [тест]", used);
  assert.ok(a.length <= 31 && b.length <= 31 && a !== b && !/[:\\/?*[\]]/.test(a));
});

test("GetProductBaseTemplate reply: product list found in any shape, unknown shape → null (never 'empty base')", () => {
  assert.deepEqual(findProductList({ ResultCode: 0, ProductBaseTemplate: { Id: 5, Products: [{ ProductId: 7, Disabled: 1 }] } }), [{ productId: "7", disabled: true }]);
  assert.deepEqual(findProductList({ ResultCode: 0, Products: [{ ProductId: "8" }] }), [{ productId: "8", disabled: null }]);
  assert.equal(findProductList({ ResultCode: 0, Response: "ok" }), null);
});
