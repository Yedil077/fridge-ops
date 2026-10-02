/**
 * REAL KiT Shop connectivity diagnostic — READ ONLY (CheckAuth, GetShops, GetShopStocks, GetSales).
 * Uses the production transport and read client of the app. Never calls a write method.
 *
 *   npm run kitshop:diagnose            # human-readable report
 *   npm run kitshop:diagnose -- --json  # JSON report
 *
 * Needs on the machine where it runs (never commit them):
 *   KITSHOP_COMPANY_ID, KITSHOP_LOGIN, KITSHOP_PASSWORD   (+ KITSHOP_API_URL, default https://api.kitshop.ru/APIService.svc)
 *   KITSHOP_REAL_DIAGNOSTICS=true (or KITSHOP_ENABLED=true) — explicit consent to call KiT Shop
 *   optional: KITSHOP_TEST_SHOP_ID, KITSHOP_SIGN_CASE=lower|upper, APP_TIMEZONE (default Asia/Almaty)
 * Runs with --conditions=react-server so the server-only modules load outside Next.js.
 */
import { readKitShopConfig } from "../src/services/kitshop/config";
import { formatReport, runRealDiagnostic } from "../src/services/kitshop/realDiagnostic";
import { ARCHETYPES } from "../src/lib/simulator/archetypes";
import { wallClockNow } from "../src/lib/time";

async function main() {
  const json = process.argv.includes("--json");
  if (process.env.KITSHOP_REAL_DIAGNOSTICS !== "true" && process.env.KITSHOP_ENABLED !== "true") {
    console.error("Refusing to call KiT Shop: set KITSHOP_REAL_DIAGNOSTICS=true (read-only diagnostic) or KITSHOP_ENABLED=true.");
    process.exit(2);
  }
  const config = readKitShopConfig();
  const report = await runRealDiagnostic({
    config,
    knownShopIds: ARCHETYPES.map((a) => a.kitshopId).filter((x): x is string => !!x),
    testShopId: process.env.KITSHOP_TEST_SHOP_ID || undefined,
    now: () => wallClockNow(process.env.APP_TIMEZONE || "Asia/Almaty"),
  });
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
  process.exit(Object.values(report.summary).every((v) => v === "PASS") ? 0 : 1);
}

main().catch((e) => {
  console.error("diagnostic crashed:", e instanceof Error ? e.message : e);
  process.exit(3);
});
