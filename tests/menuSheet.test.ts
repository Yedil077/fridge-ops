import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { readXlsx, colIndex } from "../src/lib/server/xlsx";
import { dueMenuSlot, importMenuPlan, menuPlanFromSheets, menuSheetHours, menuSheetId, pointOf } from "../src/lib/server/menuSheet";
import type { NightPlan } from "../src/lib/kitshop-data/repo";

/** a tiny zip (stored + deflated entries; the reader does not check CRCs) */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  let i = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, "utf8");
    const deflate = i++ % 2 === 0;
    const data = deflate ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data);
    central.push(ch, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const COLS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const col = (i: number) => (i < 26 ? COLS[i] : COLS[Math.floor(i / 26) - 1] + COLS[i % 26]);

/** cells: rows of values; strings go to sharedStrings, numbers stay numbers */
function xlsx(sheets: Record<string, (string | number | null)[][]>): Buffer {
  const strings: string[] = [];
  const sid = (s: string) => (strings.includes(s) ? strings.indexOf(s) : strings.push(s) - 1);
  const files: Record<string, string> = {};
  const names = Object.keys(sheets);
  names.forEach((name, k) => {
    const rows = sheets[name]
      .map((r, ri) => {
        const cells = r
          .map((v, ci) => {
            if (v === null) return "";
            const ref = `${col(ci)}${ri + 1}`;
            return typeof v === "number" ? `<c r="${ref}" s="3"><v>${v}.0</v></c>` : `<c r="${ref}" t="s"><v>${sid(v)}</v></c>`;
          })
          .join("");
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join("");
    files[`xl/worksheets/sheet${k + 1}.xml`] = `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;
  });
  files["xl/workbook.xml"] = `<workbook><sheets>${names.map((n, k) => `<sheet state="visible" name="${n}" sheetId="${k + 1}" r:id="rId${k + 4}"/>`).join("")}</sheets></workbook>`;
  files["xl/_rels/workbook.xml.rels"] = `<Relationships>${names.map((_, k) => `<Relationship Id="rId${k + 4}" Type="x" Target="worksheets/sheet${k + 1}.xml"/>`).join("")}</Relationships>`;
  files["xl/sharedStrings.xml"] = `<sst>${strings.map((s) => `<si><t xml:space="preserve">${s.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}</t></si>`).join("")}</sst>`;
  return zip(files);
}

const HEAD = ["Шарипова 4эт", "Восток", "Food2Go Достык", "Канкорд 1 этаж", "БЦ Сатти 2 эт", "Каблан 3 этаж", "ЗАММЛЕР Назарбаева ", "Итого (Каспи)"];
const day = (serial: number) => [null, serial, ...HEAD];
const SHEET = [
  day(46349), // 23.11.2026
  [1, "Старое блюдо", 9, 9, 9, 9, 9, 9, 9, 63],
  ["", "ПОНЕДЕЛЬНИК"],
  day(46350), // 24.11.2026
  [null, "Завтрак КП"],
  [1, "Банановые панкейки ", 3, 7, 5, 6, 6, 7, 3, 32],
  [null, "Перекус ПП"],
  [1, 'Киш "с лососем" & брокколи', 4, "-", 2, 8, 11, 0, 4, 31],
  [null, "Цена", 891, 990, null, null, null, null, null, null],
  [null, "ВТОРНИК"],
  [1, "Не наше", 5, 5, 5, 5, 5, 5, 5, 5],
];

test("xlsx: column letters and a workbook read back", () => {
  assert.equal(colIndex("A1"), 0);
  assert.equal(colIndex("AE12"), 30);
  const sheets = readXlsx(xlsx({ "2 неделя 23.11-29.11": SHEET }));
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].name, "2 неделя 23.11-29.11");
  const rows = sheets[0].rows();
  assert.equal(rows[3].get(1), "46350.0");
  assert.equal(rows[7].get(1), 'Киш "с лососем" & брокколи');
});

test("menu sheet: header names map to our fridges only", () => {
  assert.equal(pointOf("Шарипова 4эт"), "621287");
  assert.equal(pointOf("Канкорд 1 этаж"), "622550");
  assert.equal(pointOf("БЦ Сатти 2 эт"), "621826");
  assert.equal(pointOf("ЗАММЛЕР Назарбаева "), "622553");
  assert.equal(pointOf("Food2Go Достык"), null);
  assert.equal(pointOf("Кофейня Достык"), null);
  assert.equal(pointOf("Итого (Каспи)"), null);
});

test("menu sheet: one day's block, exactly as written (groups, no prices, no other companies, stops at the weekday row)", () => {
  const sheets = readXlsx(xlsx({ "2 неделя 23.11-29.11": SHEET }));
  const p = menuPlanFromSheets(sheets, "2026-11-24");
  assert.ok(p);
  assert.equal(p.source, "2 неделя 23.11-29.11 · 24.11.2026");
  const by = (name: string) => Object.fromEntries(p.rows.filter((r) => r.name === name).map((r) => [r.shopId, r.qty]));
  assert.deepEqual(by("Банановые панкейки"), { "621287": 3, "621136": 7, "622550": 6, "621826": 6, "621135": 7, "622553": 3 });
  assert.deepEqual(by('Киш "с лососем" & брокколи'), { "621287": 4, "622550": 8, "621826": 11, "622553": 4 });
  assert.equal(p.rows.find((r) => r.name === "Банановые панкейки")?.group, "Завтрак КП");
  assert.equal(p.rows.find((r) => r.name.startsWith("Киш"))?.group, "Перекус ПП");
  assert.equal(p.rows.some((r) => r.name === "Цена" || r.name === "Не наше" || r.name === "Старое блюдо"), false);
  assert.equal(p.rows.reduce((a, r) => a + r.qty, 0), 32 + 27);
  assert.equal(menuPlanFromSheets(sheets, "2026-11-25"), null);
  // the previous day ends at the weekday row
  assert.equal(menuPlanFromSheets(sheets, "2026-11-23")?.rows.length, 6);
});

test("menu sheet: import stores the plan; an empty / missing day never replaces it", async () => {
  const store = new Map<string, NightPlan>();
  const repo = { getNightPlan: async (d: string) => store.get(d) ?? null, setNightPlan: async (d: string, p: NightPlan) => void store.set(d, p) };
  const file = xlsx({ w: SHEET });
  const deps = { id: "x".repeat(30), download: async () => file, now: () => 1_000 };
  const r = await importMenuPlan(repo, "2026-11-24", "таблица · авто 17:00", deps);
  assert.deepEqual({ rows: r.rows, units: r.units, changed: r.changed }, { rows: 10, units: 59, changed: true });
  assert.equal(store.get("2026-11-24")?.importedBy, "таблица · авто 17:00");
  assert.equal((await importMenuPlan(repo, "2026-11-24", "x", deps)).changed, false);
  await assert.rejects(importMenuPlan(repo, "2026-11-25", "x", deps), /нет дня 25\.11/);
  await assert.rejects(importMenuPlan(repo, "2026-11-24", "x", { ...deps, id: null }), /MENU_SHEET_ID/);
});

test("menu sheet: id from env or a pasted link; hours; due slots at 17:00 and 19:00", () => {
  assert.equal(menuSheetId({ MENU_SHEET_ID: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWx/edit?gid=1" }), "1AbCdEfGhIjKlMnOpQrStUvWx");
  assert.equal(menuSheetId({ MENU_SHEET_ID: "" }), null);
  assert.deepEqual(menuSheetHours({}), [17, 19]);
  assert.deepEqual(menuSheetHours({ MENU_SHEET_HOURS: "19, 17,x,30" }), [17, 19]);

  const at = (h: number, m = 0) => Date.UTC(2026, 10, 23, h, m); // wall clock, 23.11
  const st = { done: new Set<string>(), failedAt: null as number | null, last: null };
  assert.equal(dueMenuSlot(at(16, 59), [17, 19], st), null);
  assert.deepEqual(dueMenuSlot(at(17, 0), [17, 19], st), { date: "2026-11-24", hour: 17 });
  st.done.add("2026-11-24@17");
  assert.equal(dueMenuSlot(at(18, 30), [17, 19], st), null);
  assert.deepEqual(dueMenuSlot(at(19, 5), [17, 19], st), { date: "2026-11-24", hour: 19 });
  // a failed read waits 10 minutes
  st.failedAt = at(19, 5);
  assert.equal(dueMenuSlot(at(19, 10), [17, 19], st), null);
  assert.deepEqual(dueMenuSlot(at(19, 16), [17, 19], st), { date: "2026-11-24", hour: 19 });
  // a server woken at 21:00 reads once (the latest slot)
  assert.deepEqual(dueMenuSlot(at(21), [17, 19], { done: new Set(), failedAt: null, last: null }), { date: "2026-11-24", hour: 19 });
  // after midnight — nothing (tonight's plan was read in the evening)
  assert.equal(dueMenuSlot(Date.UTC(2026, 10, 24, 0, 30), [17, 19], { done: new Set(), failedAt: null, last: null }), null);
});
