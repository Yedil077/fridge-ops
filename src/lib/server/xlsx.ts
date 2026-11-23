import { inflateRawSync } from "node:zlib";

/**
 * A minimal .xlsx reader (zip + sheet XML), enough to read the kitchen's menu table: sheet names in workbook order and,
 * per sheet, the cell values row by row. Formulas give their cached value; styles and dates are left as raw numbers.
 * No dependency: the file is read only, never written.
 */

export type XlsxSheet = { name: string; rows: () => Map<number, string>[] };

function unzip(buf: Buffer): Map<string, () => Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("не xlsx: нет оглавления zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, () => Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("не xlsx: битое оглавление zip");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    files.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`zip: метод сжатия ${method} не поддерживается`);
    });
  }
  return files;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export const xmlText = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENT[e] ?? m),
  );

/** "AE12" → column index 30 (A = 0) */
export function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** every <t> of a shared / inline string, without phonetic hints */
const textOf = (si: string) => xmlText([...si.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));

export function readXlsx(buf: Buffer): XlsxSheet[] {
  const files = unzip(buf);
  const read = (path: string) => {
    const f = files.get(path);
    return f ? f().toString("utf8") : null;
  };
  const wb = read("xl/workbook.xml");
  if (!wb) throw new Error("не xlsx: нет xl/workbook.xml");
  const rels = new Map<string, string>();
  for (const m of (read("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) rels.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  let shared: string[] | null = null;
  const strings = () => (shared ??= [...(read("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])));

  return [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const name = xmlText(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? "");
    const path = rels.get(/\br:id="([^"]+)"/.exec(m[0])?.[1] ?? "") ?? "";
    return {
      name,
      rows: () => {
        const xml = read(path) ?? "";
        const ss = strings();
        const out: Map<number, string>[] = [];
        for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
          const r = Number(/\br="(\d+)"/.exec(row[1])?.[1] ?? out.length + 1) - 1;
          const cells = new Map<number, string>();
          for (const c of row[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const ref = /\br="([A-Z]+)\d+"/.exec(c[1])?.[1];
            if (!ref || !c[2]) continue;
            const t = /\bt="(\w+)"/.exec(c[1])?.[1];
            let v: string | null;
            if (t === "inlineStr") v = textOf(/<is>([\s\S]*?)<\/is>/.exec(c[2])?.[1] ?? "");
            else {
              const raw = /<v>([\s\S]*?)<\/v>/.exec(c[2])?.[1];
              v = raw === undefined ? null : t === "s" ? (ss[Number(raw)] ?? "") : xmlText(raw);
            }
            if (v !== null && v !== "") cells.set(colIndex(ref), v);
          }
          out[r] = cells;
        }
        return Array.from(out, (x) => x ?? new Map<number, string>());
      },
    };
  });
}
