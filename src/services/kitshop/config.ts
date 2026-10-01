import "server-only";
import { z } from "zod";
import { DEFAULT_BASE_URL } from "./transport";

/**
 * KitShop credentials are read ONLY on the server from environment variables.
 * They are never exported to the client, never logged, never stored in our database.
 */
const EnvSchema = z.object({
  KITSHOP_ENABLED: z.enum(["true", "false"]).default("false"),
  KITSHOP_API_URL: z.string().url().optional().or(z.literal("")),
  KITSHOP_COMPANY_ID: z.string().optional(),
  KITSHOP_LOGIN: z.string().optional(),
  KITSHOP_PASSWORD: z.string().optional(),
});

export interface KitShopConfig {
  enabled: boolean;
  baseUrl: string;
  companyId: string;
  login: string;
  password: string;
}

export function readKitShopConfig(): KitShopConfig {
  const env = EnvSchema.parse({
    KITSHOP_ENABLED: process.env.KITSHOP_ENABLED ?? "false",
    KITSHOP_API_URL: process.env.KITSHOP_API_URL ?? "",
    KITSHOP_COMPANY_ID: process.env.KITSHOP_COMPANY_ID,
    KITSHOP_LOGIN: process.env.KITSHOP_LOGIN,
    KITSHOP_PASSWORD: process.env.KITSHOP_PASSWORD,
  });
  return {
    enabled: env.KITSHOP_ENABLED === "true",
    baseUrl: env.KITSHOP_API_URL || DEFAULT_BASE_URL,
    companyId: env.KITSHOP_COMPANY_ID ?? "",
    login: env.KITSHOP_LOGIN ?? "",
    password: env.KITSHOP_PASSWORD ?? "",
  };
}

/**
 * Write gate (docs/KITSHOP_WRITE_API_AUDIT.md §4). A REAL write needs ALL of:
 * KITSHOP_ENABLED=true, KITSHOP_WRITE_ENABLED=true, KITSHOP_WRITE_DRY_RUN=false and the shop in KITSHOP_WRITE_SHOPS.
 */
export interface KitShopWriteConfig {
  writeEnabled: boolean;
  dryRun: boolean;
  /** KiT Shop ShopIds allowed for real writes. Empty = none. */
  shops: string[];
  /** ms to wait for KiT Shop before the operation becomes UNKNOWN */
  timeoutMs: number;
  /** set to true after Phase D proved that MakeFillUp.Notes comes back in GetFillUps */
  notesRoundTripVerified: boolean;
}

export function readKitShopWriteConfig(): KitShopWriteConfig {
  return {
    writeEnabled: process.env.KITSHOP_WRITE_ENABLED === "true",
    dryRun: process.env.KITSHOP_WRITE_DRY_RUN !== "false",
    shops: (process.env.KITSHOP_WRITE_SHOPS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    timeoutMs: Math.min(30_000, Math.max(3_000, Number(process.env.KITSHOP_WRITE_TIMEOUT_MS) || 10_000)),
    notesRoundTripVerified: process.env.KITSHOP_NOTES_VERIFIED === "true",
  };
}

/** Safe status for the UI — booleans only, never values. */
export function kitShopStatus() {
  const c = readKitShopConfig();
  const w = readKitShopWriteConfig();
  return {
    enabled: c.enabled,
    hasUrl: !!c.baseUrl,
    hasCompanyId: !!c.companyId,
    hasCredentials: !!c.login && !!c.password,
    writeEnabled: w.writeEnabled,
    writeDryRun: w.dryRun,
    writeShops: w.shops.length,
  };
}
