import { readXlsx, type XlsxSheet } from "./xlsx";
import type { NightPlan } from "../kitshop-data/repo";
import { dayNumber, isoDate, minuteOfDay, wallClockNow } from "../time";

/**
 * The kitchen's table «Каспи Меню по неделям» (an .xlsx on Google Drive, shared "anyone with the link" — READ ONLY:
 * the app downloads it and never writes anything there). One sheet per week; every day is a block:
 *   header row:  B = the date (Excel serial), C… = point names (Шарипова 4эт, Восток, …, ЗАММЛЕР Назарбаева, Итого …)
 *   group rows:  B = "Завтрак КП", "Перекус ПП", … (no numbers)
 *   dish rows:   B = the dish, the point columns = how many go to that point
 * The block ends at the next day's header or at the weekday / «Принял» / «Сдал» rows under it.
 * Only our 15 fridges are taken; Food2Go, coffee shops and other companies are not ours.
 * MENU_SHEET_ID — the Drive file id (from its link); the repository is public, so the id lives only in the env.
 */

/** sheet header → KiT Shop ShopId (Food2Go / Кофейня … never match: the patterns are anchored at the start) */
const POINTS: [RegExp, string][] = [
  [/^шарипова/, "621287"],
  [/^восток/, "621136"],
  [/^запад/, "621288"],
  [/^досмухамедова/, "622552"],
  [/^к[ао]нкорд\s*1(\D|$)/, "622550"],
  [/^к[ао]нкорд\s*2(\D|$)/, "621137"],
  [/^к[ао]нкорд\s*5(\D|$)/, "622554"],
  [/^каблан\s*3(\D|$)/, "621135"],
  [/^каблан\s*5(\D|$)/, "621286"],
  [/^каблан\s*6(\D|$)/, "622555"],
  [/^(бц\s*)?сатти\s*1(\D|$)/, "621583"],
  [/^(бц\s*)?сатти\s*(2|а2)(\D|$)/, "621826"],
  [/^(бц\s*)?сатти\s*4(\D|$)/, "621586"],
  [/^жибек/, "622551"],
  [/^заммлер/, "622553"],
];

const GROUP = /^(завтрак|перекус|горяч|салат|десерт|напит)/i;
const STOP = /^(понедельник|вторник|среда|четверг|пятница|суббота|воскресенье|принял|сдал)/i;
/** a dish never goes to one fridge in such numbers — a price or a total row, not a quantity */
const MAX_QTY = 60;
const EXCEL_EPOCH_DAY = Math.round(Date.UTC(1899, 11, 30) / 86_400_000);

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
export const pointOf = (header: string) => POINTS.find(([re]) => re.test(norm(header)))?.[1] ?? null;
/** the day number of an Excel date serial ("46350" / "46350.0"), or null */
const serialDay = (v: string | undefined) => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 40_000 && n < 60_000 ? EXCEL_EPOCH_DAY + Math.floor(n) : null;
};

export type MenuPlan = { source: string; rows: NightPlan["rows"] };

/** The block of one delivery date ("2026-11-24") from the workbook, exactly as written; null if there is none. */
export function menuPlanFromSheets(sheets: XlsxSheet[], dateIso: string): MenuPlan | null {
  const day = Math.floor(Date.parse(`${dateIso}T00:00:00Z`) / 86_400_000);
  for (const sheet of sheets) {
    const rows = sheet.rows();
    const columnsOf = (r: Map<number, string>) => {
      const cols = new Map<number, string>();
      for (const [c, v] of r) {
        const shop = c >= 2 ? pointOf(v) : null;
        if (shop && ![...cols.values()].includes(shop)) cols.set(c, shop);
      }
      return cols;
    };
    const head = rows.findIndex((r) => serialDay(r.get(1)) === day && columnsOf(r).size >= 5);
    if (head < 0) continue;
    const cols = columnsOf(rows[head]);
    const out: NightPlan["rows"] = [];
    let group = "Другое";
    for (let i = head + 1; i < rows.length; i++) {
      const r = rows[i];
      const name = (r.get(1) ?? "").replace(/\s+/g, " ").trim();
      if (serialDay(r.get(1)) !== null && columnsOf(r).size >= 5) break;
      if (STOP.test(name)) break;
      if (!name) continue;
      const qty = [...cols].map(([c, shopId]) => ({ shopId, v: (r.get(c) ?? "").trim() }));
      const nums = qty.map((q) => ({ ...q, n: Number(q.v) })).filter((q) => q.v !== "" && Number.isFinite(q.n));
      if (GROUP.test(name) && nums.length === 0) {
        group = name;
        continue;
      }
      if (nums.some((q) => q.n > MAX_QTY || q.n < 0 || !Number.isInteger(q.n))) continue;
      for (const q of nums) if (q.n > 0) out.push({ shopId: q.shopId, name, productId: null, group, qty: q.n });
    }
    const d = isoDate(day);
    return { source: `${sheet.name.trim()} · ${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`, rows: out };
  }
  return null;
}

export function menuSheetId(env: Record<string, string | undefined> = process.env): string | null {
  const v = (env.MENU_SHEET_ID ?? "").trim();
  const id = /\/d\/([A-Za-z0-9_-]{20,})/.exec(v)?.[1] ?? v; // a whole link pasted is fine too
  return /^[A-Za-z0-9_-]{20,}$/.test(id) ? id : null;
}

/** Downloads the workbook (public "view by link" download, read only). */
export async function downloadMenuSheet(id: string): Promise<Buffer> {
  const res = await fetch(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`, {
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Google Drive ответил ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50)
    throw new Error("Google Drive отдал не файл .xlsx — таблица должна быть открыта «всем, у кого есть ссылка» на просмотр");
  return buf;
}

export type MenuImportResult = { date: string; source: string; rows: number; units: number; changed: boolean };

type Store = { getNightPlan(date: string): Promise<NightPlan | null>; setNightPlan(date: string, plan: NightPlan): Promise<void> };

/** Reads the table and stores the date's plan (replaces the previous one — the table is the priority). */
export async function importMenuPlan(
  repo: Store,
  dateIso: string,
  by: string,
  deps: { download?: (id: string) => Promise<Buffer>; now?: () => number; id?: string | null } = {},
): Promise<MenuImportResult> {
  const id = deps.id !== undefined ? deps.id : menuSheetId();
  if (!id) throw new Error("Таблица меню не подключена: на сервере нужна переменная MENU_SHEET_ID (id из ссылки на таблицу)");
  const buf = await (deps.download ?? downloadMenuSheet)(id);
  const plan = menuPlanFromSheets(readXlsx(buf), dateIso);
  if (!plan) throw new Error(`В таблице нет дня ${dateIso.slice(8, 10)}.${dateIso.slice(5, 7)} — кухня ещё не заполнила`);
  if (!plan.rows.length) throw new Error(`День ${dateIso.slice(8, 10)}.${dateIso.slice(5, 7)} в таблице пустой — план не заменён`);
  const prev = await repo.getNightPlan(dateIso);
  const key = (rows: NightPlan["rows"]) => JSON.stringify(rows.map((r) => [r.shopId, r.name, r.group, r.qty]));
  const changed = !prev || key(prev.rows) !== key(plan.rows);
  await repo.setNightPlan(dateIso, { source: plan.source, importedAt: (deps.now ?? (() => wallClockNow(TZ)))(), importedBy: by, rows: plan.rows });
  return { date: dateIso, source: plan.source, rows: plan.rows.length, units: plan.rows.reduce((a, r) => a + r.qty, 0), changed };
}

const TZ = process.env.APP_TIMEZONE || "Asia/Almaty";

/** MENU_SHEET_HOURS="17,19" — the hours (local) the next day's plan is read again */
export function menuSheetHours(env: Record<string, string | undefined> = process.env): number[] {
  const hs = (env.MENU_SHEET_HOURS ?? "17,19")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  return [...new Set(hs)].sort((a, b) => a - b);
}

export type MenuScheduleState = { done: Set<string>; failedAt: number | null; last: { at: number; ok: boolean; text: string } | null };

/**
 * Which slot is due now: at 17:00 and 19:00 (local) the plan for TOMORROW's delivery is read. A slot missed while the
 * server was asleep runs as soon as it is up (the same evening); a failed read is retried every 10 minutes.
 */
export function dueMenuSlot(now: number, hours: number[], st: MenuScheduleState): { date: string; hour: number } | null {
  const minute = minuteOfDay(now);
  const date = isoDate(dayNumber(now) + 1);
  const due = hours.filter((h) => minute >= h * 60 && !st.done.has(`${date}@${h}`));
  if (!due.length) return null;
  if (st.failedAt !== null && now - st.failedAt < 10 * 60_000) return null;
  return { date, hour: due[due.length - 1] };
}

export function startMenuSheetSchedule(getRepo: () => Store | null, audit: (what: string, data: Record<string, unknown>) => void): MenuScheduleState {
  const st: MenuScheduleState = { done: new Set(), failedAt: null, last: null };
  const hours = menuSheetHours();
  if (!menuSheetId()) {
    console.info("[menu-sheet] MENU_SHEET_ID не задан — план из таблицы загружается только вручную");
    return st;
  }
  console.info(`[menu-sheet] план на завтра читается из таблицы в ${hours.map((h) => `${String(h).padStart(2, "0")}:00`).join(", ")}`);
  let running = false;
  const tick = async () => {
    const repo = getRepo();
    const now = wallClockNow(TZ);
    const slot = dueMenuSlot(now, hours, st);
    if (!repo || !slot || running) return;
    running = true;
    const by = `таблица · авто ${String(slot.hour).padStart(2, "0")}:00`;
    try {
      const r = await importMenuPlan(repo, slot.date, by);
      for (const h of hours) if (h <= slot.hour) st.done.add(`${slot.date}@${h}`);
      st.failedAt = null;
      st.last = { at: now, ok: true, text: `${r.date}: ${r.rows} строк, ${r.units} шт.${r.changed ? "" : " (без изменений)"}` };
      console.info(`[menu-sheet] ${by} · ${r.source} · ${r.rows} строк · ${r.units} шт.${r.changed ? " · ИЗМЕНЁН" : " · без изменений"}`);
      audit("night.plan.auto", { date: r.date, source: r.source, rows: r.rows, units: r.units, changed: r.changed });
    } catch (e) {
      st.failedAt = now;
      st.last = { at: now, ok: false, text: e instanceof Error ? e.message : String(e) };
      console.warn(`[menu-sheet] ${slot.date}: ${st.last.text} — повтор через 10 мин`);
    } finally {
      running = false;
    }
  };
  setInterval(() => void tick(), 60_000).unref?.();
  setTimeout(() => void tick(), 20_000).unref?.();
  return st;
}
