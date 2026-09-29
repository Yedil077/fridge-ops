import { z } from "zod";

/**
 * Raw KitShop DTOs.
 * ⚠ The exact response shapes are NOT confirmed yet (see docs/KITSHOP_API_REQUIREMENTS.md).
 * Schemas are intentionally permissive (passthrough) and list the fields we NEED;
 * they will be tightened once real responses are available.
 */

export const KitShopSaleSchema = z
  .object({
    saleId: z.union([z.string(), z.number()]),
    shopId: z.union([z.string(), z.number()]),
    productId: z.union([z.string(), z.number()]),
    quantity: z.number(),
    price: z.number().optional(),
    soldAt: z.string(), // ISO date-time; timezone to be confirmed
  })
  .passthrough();

export const KitShopShopSchema = z
  .object({
    shopId: z.union([z.string(), z.number()]),
    name: z.string(),
    address: z.string().optional(),
    isActive: z.boolean().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
  })
  .passthrough();

export const KitShopProductSchema = z
  .object({
    productId: z.union([z.string(), z.number()]),
    name: z.string(),
    group: z.string().optional(),
    price: z.number().optional(),
  })
  .passthrough();

export const KitShopStockSchema = z
  .object({
    shopId: z.union([z.string(), z.number()]),
    productId: z.union([z.string(), z.number()]),
    quantity: z.number(),
    at: z.string().optional(),
  })
  .passthrough();

export type KitShopSale = z.infer<typeof KitShopSaleSchema>;
export type KitShopShop = z.infer<typeof KitShopShopSchema>;
export type KitShopProduct = z.infer<typeof KitShopProductSchema>;
export type KitShopStock = z.infer<typeof KitShopStockSchema>;

export interface SalesQuery {
  /** ISO date-time, inclusive */
  from: string;
  /** ISO date-time, exclusive */
  to: string;
  shopIds?: string[];
}
