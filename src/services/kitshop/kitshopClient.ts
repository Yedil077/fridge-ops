import "server-only";
import { z } from "zod";
import { readKitShopConfig, type KitShopConfig } from "./config";
import { KitShopTransport, kitshopDate, type KitShopEnvelope } from "./transport";
import {
  KitShopFillUpSchema,
  KitShopProductSchema,
  KitShopSaleSchema,
  KitShopSalesByProductSchema,
  KitShopSaleDetailSchema,
  type KitShopSaleDetail,
  type KitShopSalesByProduct,
  KitShopShopSchema,
  KitShopStockSchema,
  type KitShopFillUp,
  type KitShopProduct,
  type KitShopSale,
  type KitShopShop,
  type KitShopStock,
  type SalesQuery,
} from "./types";

/**
 * READ-ONLY KitShop client (methods documented in the official API v1.3 — see docs/KITSHOP_WRITE_API_AUDIT.md).
 *
 * Rules enforced by construction:
 *  • the only public methods are read methods (get*); there is no generic request() exposed;
 *  • every call goes through READ_ENDPOINTS — a whitelist of documented READ methods;
 *  • KITSHOP_ENABLED=true is required, otherwise the client refuses to send anything;
 *  • credentials come from server env only and are never logged.
 * KiT Shop uses POST for every method (reads included); "read" is defined by the method name, not the verb.
 * Writes live in a separate, gated module (writer.ts) — never here.
 */

interface ReadEndpoint {
  path: string;
  /** documented in the official API docs */
  confirmed: boolean;
  note: string;
}

export const READ_ENDPOINTS = {
  checkAuth: { path: "CheckAuth", confirmed: true, note: "§3.1 проверка логина/подписи" },
  shops: { path: "GetShops", confirmed: true, note: "§3.2 справочник торговых точек" },
  products: { path: "GetProducts", confirmed: true, note: "§3.3 справочник товаров (Barcode, VendorCode)" },
  stocks: { path: "GetShopStocks", confirmed: true, note: "§3.20 остатки одной торговой точки" },
  sales: { path: "GetSales", confirmed: true, note: "§3.22 продажи без позиций (позиции — GetSaleById), период ≤ 60 дней" },
  fillUps: { path: "GetFillUps", confirmed: true, note: "§3.19 операции загрузки и снятия (FillUps), период ≤ 60 дней" },
  fillUpById: { path: "GetFillUpById", confirmed: true, note: "§3.12 детали операции загрузки/снятия" },
  saleById: { path: "GetSaleById", confirmed: true, note: "§3.10 один чек с позициями (товар, количество, цена)" },
  salesByProducts: { path: "GetSalesByProducts", confirmed: true, note: "§3.26 продажи в разрезе товаров по всей компании, период ≤ 60 дней" },
} as const satisfies Record<string, ReadEndpoint>;

type EndpointName = keyof typeof READ_ENDPOINTS;

export class KitShopNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KitShopNotReadyError";
  }
}

export class KitShopResultError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = "KitShopResultError";
  }
}

export class KitShopReadOnlyClient {
  readonly #config: KitShopConfig;
  readonly #transport: KitShopTransport;

  constructor(config: KitShopConfig = readKitShopConfig(), transport?: KitShopTransport) {
    this.#config = config;
    this.#transport = transport ?? new KitShopTransport(config);
  }

  async getAuthCheck(): Promise<boolean> {
    await this.#read("checkAuth", {});
    return true;
  }

  async getShops(): Promise<KitShopShop[]> {
    return this.#list("shops", {}, "Shops", KitShopShopSchema);
  }

  async getProducts(): Promise<KitShopProduct[]> {
    return this.#list("products", {}, "Products", KitShopProductSchema);
  }

  /** Stock of ONE shop. ResultCode 100 = no stock / not tracked → empty list. */
  async getShopStocks(shopId: string): Promise<KitShopStock[]> {
    return this.#list("stocks", { Id: Number(shopId) }, "Stocks", KitShopStockSchema);
  }

  async getSales(q: SalesQuery): Promise<KitShopSale[]> {
    return this.#list("sales", { Filter: this.#filter(q) }, "Sales", KitShopSaleSchema);
  }

  async getFillUps(q: SalesQuery): Promise<KitShopFillUp[]> {
    return this.#list("fillUps", { Filter: this.#filter(q) }, "FillUps", KitShopFillUpSchema);
  }

  /** One receipt with its positions — the only documented source of product-level sales per fridge and time. */
  async getSaleById(id: string): Promise<KitShopSaleDetail | null> {
    return (await this.#list("saleById", { Id: Number(id) }, "Sales", KitShopSaleDetailSchema))[0] ?? null;
  }

  /** Company-wide quantity sold per product in [from, to] (≤ 60 days). The filter has no ShopId in the docs. */
  async getSalesByProducts(q: { from: number; to: number }): Promise<KitShopSalesByProduct[]> {
    return this.#list("salesByProducts", { Filter: this.#filter(q) }, "SalesByProducts", KitShopSalesByProductSchema);
  }

  async getFillUpById(id: string): Promise<KitShopFillUp | null> {
    return (await this.#list("fillUpById", { Id: Number(id) }, "FillUps", KitShopFillUpSchema))[0] ?? null;
  }

  #filter(q: SalesQuery) {
    if (q.to - q.from > 60 * 86_400_000) throw new Error("KiT Shop: period must be ≤ 60 days");
    return { UpDate: kitshopDate(q.from), ToDate: kitshopDate(q.to), ...(q.shopId ? { ShopId: Number(q.shopId) } : {}) };
  }

  async #list<T>(name: EndpointName, params: Record<string, unknown>, key: string, item: z.ZodType<T>): Promise<T[]> {
    const env = await this.#read(name, params, true);
    if (env.ResultCode === 100) return [];
    return z.array(item).parse(env[key] ?? []);
  }

  /** Private: the single place that talks to the network. Whitelisted read methods only. */
  async #read(name: EndpointName, params: Record<string, unknown>, allowEmpty = false): Promise<KitShopEnvelope> {
    const ep: ReadEndpoint = READ_ENDPOINTS[name];
    if (!this.#config.enabled) throw new KitShopNotReadyError("KitShop отключён (KITSHOP_ENABLED != true).");
    if (!ep.confirmed) throw new KitShopNotReadyError(`Метод «${name}» не подтверждён документацией: ${ep.note}`);
    const env = await this.#transport.call(ep.path, params);
    if (env.ResultCode === 0 || (allowEmpty && env.ResultCode === 100)) return env;
    throw new KitShopResultError(env.ResultCode, `KitShop ${ep.path}: ${env.ErrorMessage ?? env.Response ?? "ошибка"} (код ${env.ResultCode})`);
  }
}

/** Guard used by tests / health check: the public surface must contain read methods only. */
export function assertReadOnlySurface(): { ok: boolean; methods: string[] } {
  const methods = Object.getOwnPropertyNames(KitShopReadOnlyClient.prototype).filter((m) => m !== "constructor");
  const forbidden = methods.filter((m) => /^(create|update|delete|remove|post|put|patch|set|write|insert|upsert|make|add|edit)/i.test(m));
  return { ok: forbidden.length === 0 && methods.every((m) => m.startsWith("get")), methods };
}
