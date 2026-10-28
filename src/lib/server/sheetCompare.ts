import "server-only";
import { fillDirection } from "../kitshop-data/snapshot";
import type { KsDataset } from "../kitshop-data/dataset";
import { dayNumber } from "../time";

/**
 * Сверка KiT Shop (our read-only copy) ↔ Google Sheets «Интеграция kitshop» (the company's own export of the same
 * KiT Shop). Only READS the sheet through its public CSV query endpoint (the sheet must be shared "anyone with the link");
 * nothing replaces KiT Shop — this only shows where the two disagree.
 *   • CompleteSales: SaleId, ShopId (B), SaleDateTime (D), Quantity (J), ProductId (K)
 *   • FillUpsDetails: ShopId (B), FillupType (E), FillupDateTime (G), ProductId (L), Quantity (P)
 * GOOGLE_SHEET_ID — the sheet id (from its link). Without it the comparison is off.
 */

const DAY = 86_400_000;

export function sheetId(env: Record<string, string | undefined> = process.env): string | null {
  const v = (env.GOOGLE_SHEET_ID ?? "").trim();
  return /^[A-Za-z0-9_-]{20,}$/.test(v) ? v : null;
}

/** Minimal CSV parser (quoted fields, "" escapes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cur);
      cur = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += c;
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

const num = (s: string | undefined) => {
  const n = Number(String(s ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

/** "10/27/2026 16:33:14" (gviz CSV) → wall-clock ms */
export function parseSheetDate(s: string): number | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})/.exec(s.trim());
  return m ? Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]) : null;
}

const gvizDate = (ms: number) => {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:00`;
};

type Fetcher = (url: string) => Promise<string>;
const defaultFetch: Fetcher = async (url) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`Google Sheets ответил ${res.status}`);
    const text = await res.text();
    if (/^\s*</.test(text)) throw new Error("таблица не открыта по ссылке (нужен доступ «всем, у кого есть ссылка», только чтение)");
    return text;
  } finally {
    clearTimeout(t);
  }
};

async function query(id: string, sheet: string, tq: string, fetcher: Fetcher): Promise<string[][]> {
  const url = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheet)}&tq=${encodeURIComponent(tq)}`;
  const rows = parseCsv(await fetcher(url));
  return rows.slice(1).filter((r) => r.some((x) => x !== ""));
}

export interface CompareRow {
  productId: string;
  name: string;
  ours: { sold: number; loaded: number; unloaded: number; writtenOff: number };
  sheet: { sold: number; loaded: number; unloaded: number; writtenOff: number };
}

export async function compareWithSheet(ds: KsDataset, shopId: string, now: number, opts: { id?: string | null; fetcher?: Fetcher; days?: number } = {}) {
  const id = opts.id === undefined ? sheetId() : opts.id;
  if (!id) return { configured: false as const };
  const fetcher = opts.fetcher ?? defaultFetch;
  const days = opts.days ?? 30;
  const to = dayNumber(now) * DAY; // today 00:00 — whole days only
  const from = to - days * DAY;
  const shop = Number(shopId);
  if (!Number.isFinite(shop)) throw new Error("ShopId не число");
  // 1. the same receipts in both: their times (a timezone shift between the sheet and our copy)
  const recent: { saleId: string; soldAt: number }[] = [];
  for (const sale of ds.sales.values()) if (sale.shopId === shopId && sale.detailed && sale.soldAt >= from && sale.soldAt < to) recent.push({ saleId: sale.saleId, soldAt: sale.soldAt });
  recent.sort((x, y) => y.soldAt - x.soldAt);
  const sample = recent.slice(0, 15);
  const timeDiffs: number[] = [];
  if (sample.length) {
    const tRows = await query(id, "CompleteSales", `select A, D where ${sample.map((x) => `A = ${Number(x.saleId)}`).join(" or ")}`, fetcher);
    const sheetAt = new Map(tRows.map(([sid, d]) => [sid, parseSheetDate(d)]));
    for (const x of sample) {
      const t = sheetAt.get(x.saleId);
      if (t !== null && t !== undefined) timeDiffs.push(Math.round((t - x.soldAt) / 60_000));
    }
  }
  timeDiffs.sort((x, y) => x - y);
  const shiftMin = timeDiffs.length ? timeDiffs[Math.floor(timeDiffs.length / 2)] : 0;

  // 2. totals per dish over the same whole days (the sheet's clock shifted by the measured difference)
  const sFrom = from + shiftMin * 60_000;
  const sTo = to + shiftMin * 60_000;
  const period = (col: string) => `${col} >= datetime '${gvizDate(sFrom)}' and ${col} < datetime '${gvizDate(sTo)}'`;
  const [salesRows, fillRows] = await Promise.all([
    query(id, "CompleteSales", `select K, sum(J), count(A) where B = ${shop} and ${period("D")} group by K`, fetcher),
    query(id, "FillUpsDetails", `select L, E, sum(P) where B = ${shop} and ${period("G")} group by L, E`, fetcher),
  ]);

  const rows = new Map<string, CompareRow>();
  const row = (pid: string) => {
    let r = rows.get(pid);
    if (!r) {
      r = { productId: pid, name: ds.products.get(pid)?.name ?? `#${pid}`, ours: { sold: 0, loaded: 0, unloaded: 0, writtenOff: 0 }, sheet: { sold: 0, loaded: 0, unloaded: 0, writtenOff: 0 } };
      rows.set(pid, r);
    }
    return r;
  };
  for (const [pid, qty] of salesRows) if (pid) row(pid).sheet.sold += num(qty);
  for (const [pid, type, qty] of fillRows) {
    if (!pid) continue;
    const t = num(type);
    const q = Math.abs(num(qty));
    if (t === 1) row(pid).sheet.loaded += q;
    else if (t === 2) row(pid).sheet.unloaded += q;
    else if (t === 3) row(pid).sheet.writtenOff += q;
  }

  // ours, the same whole days
  let receiptsUndetailed = 0;
  for (const s of ds.sales.values()) {
    if (s.shopId !== shopId || s.soldAt < from || s.soldAt >= to) continue;
    if (!s.detailed) receiptsUndetailed++;
    for (const l of ds.positions.get(s.saleId) ?? []) row(l.productId).ours.sold += l.qty;
  }
  let fillupsUndetailed = 0;
  for (const f of ds.fillUps.values()) {
    if (f.shopId !== shopId || f.at === null || f.at < from || f.at >= to) continue;
    if (!f.detailed) fillupsUndetailed++;
    for (const l of ds.fillUpLines.get(f.fillupId) ?? []) {
      const d = fillDirection(f.type, l.qty);
      const r = row(l.productId).ours;
      if (d.kind === "load") r.loaded += d.delta;
      else if (d.kind === "writeoff") r.writtenOff -= d.delta;
      else r.unloaded -= d.delta;
    }
  }

  const all = [...rows.values()];
  const differs = (r: CompareRow) =>
    r.ours.sold !== r.sheet.sold || r.ours.loaded !== r.sheet.loaded || r.ours.unloaded !== r.sheet.unloaded || r.ours.writtenOff !== r.sheet.writtenOff;
  const total = (k: keyof CompareRow["ours"], side: "ours" | "sheet") => Math.round(all.reduce((a, r) => a + r[side][k], 0));
  const keys = ["sold", "loaded", "unloaded", "writtenOff"] as const;
  return {
    configured: true as const,
    period: { from, to, days },
    totals: Object.fromEntries(keys.map((k) => [k, { ours: total(k, "ours"), sheet: total(k, "sheet") }])) as Record<(typeof keys)[number], { ours: number; sheet: number }>,
    products: all.length,
    mismatches: all.filter(differs).sort((a, b) => Math.abs(b.ours.sold - b.sheet.sold) - Math.abs(a.ours.sold - a.sheet.sold)),
    receiptsUndetailed,
    fillupsUndetailed,
    time: { checked: timeDiffs.length, sheetMinusOursMinutes: timeDiffs.length ? shiftMin : null },
  };
}

export type SheetCompare = Awaited<ReturnType<typeof compareWithSheet>>;
