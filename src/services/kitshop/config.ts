import "server-only";
import { z } from "zod";

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
    baseUrl: env.KITSHOP_API_URL ?? "",
    companyId: env.KITSHOP_COMPANY_ID ?? "",
    login: env.KITSHOP_LOGIN ?? "",
    password: env.KITSHOP_PASSWORD ?? "",
  };
}

/** Safe status for the UI — booleans only, never values. */
export function kitShopStatus() {
  const c = readKitShopConfig();
  return {
    enabled: c.enabled,
    hasUrl: !!c.baseUrl,
    hasCompanyId: !!c.companyId,
    hasCredentials: !!c.login && !!c.password,
  };
}
