import { z } from "zod";

/**
 * KiT Shop DTOs, field names as in the official docs v1.3.
 * Schemas are permissive (passthrough, optional fields) — real responses may carry more fields
 * or omit "Optional" ones; they are tightened after Phase D compares them with real answers.
 */

const Id = z.union([z.number(), z.string()]).transform((v) => String(v));

export const KitShopShopSchema = z
  .object({
    ShopId: Id,
    ShopName: z.string(),
    Address: z.string().nullish(),
    Place: z.string().nullish(),
    Coordinates: z.string().nullish(),
    WorkTime: z.string().nullish(),
    StocksAccounting: z.union([z.boolean(), z.number()]).nullish(),
    /** mentioned by §3.32 but missing from the GetShops field table — verify in Phase D */
    ProductBaseTemplateId: z.number().nullish(),
  })
  .passthrough();

export const KitShopProductSchema = z
  .object({
    ProductId: Id,
    ProductName: z.string(),
    UnitType: z.number().nullish(),
    Price: z.number().nullish(),
    GroupId: z.number().nullish(),
    Barcode: z.string().nullish(),
    VendorCode: z.string().nullish(),
    ShortCodes: z.string().nullish(),
  })
  .passthrough();

export const KitShopStockSchema = z
  .object({
    ProductId: Id,
    ProductName: z.string().nullish(),
    Barcode: z.string().nullish(),
    VendorCode: z.string().nullish(),
    Quantity: z.number(),
    ExpiryDate: z.string().nullish(),
  })
  .passthrough();

export const KitShopFillUpSchema = z
  .object({
    FillupId: Id,
    ShopId: Id,
    FillupType: z.number().nullish(),
    FillupSource: z.number().nullish(),
    DeviceId: z.number().nullish(),
    FillupDateTime: z.string().nullish(),
    UserName: z.string().nullish(),
    Notes: z.string().nullish(),
    Details: z
      .array(z.object({ ProductId: Id, Quantity: z.number(), ExpiryDate: z.string().nullish() }).passthrough())
      .nullish(),
  })
  .passthrough();

/** §3.22 GetSales — receipts without items (SaleDateTime is the time at the fridge). */
export const KitShopSaleSchema = z
  .object({
    SaleId: Id,
    ShopId: Id,
    DeviceId: Id.nullish(),
    SaleDateTime: z.string(),
    Sum: z.number().nullish(),
  })
  .passthrough();

/** §3.10 GetSaleById — one receipt with its Positions (product-level sales). */
export const KitShopSaleDetailSchema = z
  .object({
    SaleId: Id,
    ShopId: Id,
    SaleDateTime: z.string(),
    Sum: z.number().nullish(),
    Positions: z
      .array(z.object({ PositionId: Id, ProductId: Id, Price: z.number().nullish(), Quantity: z.number(), Sum: z.number().nullish() }).passthrough())
      .nullish(),
  })
  .passthrough();
export type KitShopSaleDetail = z.infer<typeof KitShopSaleDetailSchema>;

/** §3.26 GetSalesByProducts — company-wide sales per product for a period (≤ 60 days). */
export const KitShopSalesByProductSchema = z
  .object({
    ProductId: Id,
    ProductName: z.string().nullish(),
    Price: z.number().nullish(),
    Quantity: z.number(),
    TotalSum: z.number().nullish(),
  })
  .passthrough();
export type KitShopSalesByProduct = z.infer<typeof KitShopSalesByProductSchema>;

/** §3.5 GetProductGroups — product groups of the company (category of a product = its GroupId). */
export const KitShopProductGroupSchema = z.object({ GroupId: z.number(), GroupName: z.string(), Notes: z.string().nullish() }).passthrough();
export type KitShopProductGroup = z.infer<typeof KitShopProductGroupSchema>;

export type KitShopShop = z.infer<typeof KitShopShopSchema>;
export type KitShopProduct = z.infer<typeof KitShopProductSchema>;
export type KitShopStock = z.infer<typeof KitShopStockSchema>;
export type KitShopFillUp = z.infer<typeof KitShopFillUpSchema>;
export type KitShopSale = z.infer<typeof KitShopSaleSchema>;

export interface SalesQuery {
  /** wall-clock ms, inclusive */
  from: number;
  /** wall-clock ms; the period must be ≤ 60 days (ResultCode 30) */
  to: number;
  shopId?: string;
}
