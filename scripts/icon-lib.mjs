// Tiny PNG renderer for the Fridge Ops glyph (no dependencies). Used by make-icons.mjs and android-assets.mjs.
import zlib from "node:zlib";

export const BG = [11, 12, 14]; // #0b0c0e — app background
const LINE = [110, 168, 255]; // #6ea8ff — accent
const DOT = [74, 208, 122]; // #4ad07a — good

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encode(w, h, px) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    px.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Canvas w×h filled with BG, fridge glyph of size `s` centered at (cx, cy). */
export function renderPng(w, h, s, cx = w / 2, cy = h / 2) {
  const px = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    px[i * 3] = BG[0];
    px[i * 3 + 1] = BG[1];
    px[i * 3 + 2] = BG[2];
  }
  const gw = s * 0.46, gh = s * 0.7;
  const x0 = cx - gw / 2, y0 = cy - gh / 2;
  const stroke = Math.max(2, s * 0.06);
  const r = s * 0.08;
  const shelfY = y0 + gh * 0.36;
  const inRR = (x, y, ax, ay, bw, bh, rr) => {
    if (x < ax || y < ay || x > ax + bw || y > ay + bh) return false;
    const qx = Math.min(Math.max(x, ax + rr), ax + bw - rr);
    const qy = Math.min(Math.max(y, ay + rr), ay + bh - rr);
    return (x - qx) ** 2 + (y - qy) ** 2 <= rr * rr;
  };
  const ymin = Math.max(0, Math.floor(y0 - 2)), ymax = Math.min(h, Math.ceil(y0 + gh + 2));
  const xmin = Math.max(0, Math.floor(x0 - 2)), xmax = Math.min(w, Math.ceil(x0 + gw + 2));
  for (let y = ymin; y < ymax; y++)
    for (let x = xmin; x < xmax; x++) {
      let c = null;
      const outer = inRR(x, y, x0, y0, gw, gh, r);
      const inner = inRR(x, y, x0 + stroke, y0 + stroke, gw - 2 * stroke, gh - 2 * stroke, Math.max(0, r - stroke));
      if (outer && !inner) c = LINE;
      if (inner && Math.abs(y - shelfY) < stroke / 2) c = LINE;
      const dx = x - (x0 + gw * 0.72), dy = y - (y0 + gh * 0.18);
      if (dx * dx + dy * dy < (s * 0.045) ** 2) c = DOT;
      if (c) {
        const i = (y * w + x) * 3;
        px[i] = c[0];
        px[i + 1] = c[1];
        px[i + 2] = c[2];
      }
    }
  return encode(w, h, px);
}

/** Square icon: `pad` = share of empty margin on each side. */
export function iconPng(size, pad) {
  return renderPng(size, size, size * (1 - 2 * pad));
}
