// Generates PNG web/PWA icons (no dependencies): npm run icons
import fs from "node:fs";
import path from "node:path";
import { iconPng } from "./icon-lib.mjs";

const OUT = path.join(process.cwd(), "public", "icons");
fs.mkdirSync(OUT, { recursive: true });

const files = [
  ["icon-192.png", 192, 0.06],
  ["icon-512.png", 512, 0.06],
  ["maskable-512.png", 512, 0.18],
  ["apple-touch-icon.png", 180, 0.1],
];
for (const [name, size, pad] of files) {
  fs.writeFileSync(path.join(OUT, name), iconPng(size, pad));
  console.log("wrote", name);
}
