import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
/** Source without comments — docs may mention forbidden names ("there is no updateProduct"). */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const walk = (dir: string): string[] =>
  fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );

test("KitShop client exposes read methods only", () => {
  const src = read("src/services/kitshop/kitshopClient.ts");
  const methods = [...src.matchAll(/^\s{2}(?:async\s+)?([a-zA-Z]\w*)\s*\(/gm)].map((m) => m[1]).filter((m) => m !== "constructor");
  assert.ok(methods.length >= 4);
  for (const m of methods) assert.match(m, /^get/, `public method "${m}" must be a read method`);
  assert.doesNotMatch(src, /method:\s*"(POST|PUT|PATCH|DELETE)"/);
  for (const f of walk("src/services/kitshop")) {
    assert.doesNotMatch(code(f), /\b(update|delete|create|remove)(Product|Stock|Sale|Shop)\b/, `${f} must not contain write operations`);
  }
});

test("KitShop credentials never reach client code", () => {
  const clientFiles = walk("src")
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => read(f).startsWith('"use client"'));
  for (const f of clientFiles) assert.doesNotMatch(read(f), /KITSHOP_|services\/kitshop/, `${f} must not touch KitShop`);
  assert.doesNotMatch(read(".env.example"), /NEXT_PUBLIC_KITSHOP/);
});

test("secrets are git-ignored", () => {
  const gi = read(".gitignore");
  for (const p of [".env", ".env.local", ".env.production", "*.keystore", "*.jks", ".data/"]) assert.ok(gi.includes(p), `.gitignore must contain ${p}`);
});

test("Capacitor config contains no secrets and points to our backend", () => {
  const cfg = read("capacitor.config.ts");
  assert.doesNotMatch(cfg, /KITSHOP|PASSWORD|DATABASE_URL|AUTH_SECRET/);
  assert.match(cfg, /kz\.greencity\.fridgeops/);
});
