// Rehearsal against a LOCAL FAKE KiT Shop: fake API on :4010 + `next dev` on :3100 in DATA_SOURCE=kitshop (read-only sync,
// 15 points, generated receipts). Never points at the real api.kitshop.ru. Uses a separate state dir (.data-fake/).
// KiT Shop stays read-only unless KITSHOP_READ_ONLY=false is set in your shell (then the old Phase D write rehearsal works).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAKE, startFakeKitShop } from "./fake-kitshop.mjs";

startFakeKitShop();
const env = {
  ...process.env,
  // --shadow: real (fake) data is synced in the background, screens show the simulator
  DATA_SOURCE: process.argv.includes("--shadow") ? "kitshop_shadow" : process.env.DATA_SOURCE || "kitshop",
  STORE_DRIVER: "file",
  // the fake has 10 days of receipts: a short history keeps the rehearsal fast (production default: 180 days, 300 ms)
  // 61 days: per-point sales then cover the 60-day window of the "что убрать из точки" report
  KITSHOP_BACKFILL_DAYS: process.env.KITSHOP_BACKFILL_DAYS || "61",
  KITSHOP_BACKFILL_DELAY_MS: process.env.KITSHOP_BACKFILL_DELAY_MS || "50",
  KITSHOP_ENABLED: "true",
  KITSHOP_API_URL: `http://localhost:${FAKE.port}/APIService.svc`,
  KITSHOP_COMPANY_ID: FAKE.companyId,
  KITSHOP_LOGIN: FAKE.login,
  KITSHOP_PASSWORD: FAKE.password,
  KITSHOP_WRITE_ENABLED: "true",
  KITSHOP_WRITE_DRY_RUN: "false",
  KITSHOP_WRITE_SHOPS: "621583",
  KITSHOP_WRITE_SCOPE: "test",
  FILE_STORE_DIR: ".data-fake",
};
const port = process.env.PORT || "3100";
const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["next", "dev", "-p", port], {
  env,
  cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 0));
