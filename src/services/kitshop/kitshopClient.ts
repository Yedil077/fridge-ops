import "server-only";
import { z } from "zod";
import { readKitShopConfig, type KitShopConfig } from "./config";
import {
  KitShopProductSchema,
  KitShopSaleSchema,
  KitShopShopSchema,
  KitShopStockSchema,
  type KitShopProduct,
  type KitShopSale,
  type KitShopShop,
  type KitShopStock,
  type SalesQuery,
} from "./types";

/**
 * READ-ONLY KitShop client.
 *
 * Rules enforced by construction:
 *  • the only public methods are read methods (get*); there is no generic request() exposed;
 *  • every call goes through READ_ENDPOINTS, whose HTTP verb is typed as the literal "GET";
 *  • an endpoint must be explicitly `confirmed: true` (after reading real documentation)
 *    AND KITSHOP_ENABLED=true, otherwise the client refuses to send anything;
 *  • credentials come from server env only and are never logged.
 *
 * There are intentionally NO methods like updateProduct / updateStock / deleteSale / updateShop.
 */

interface ReadEndpoint {
  method: "GET";
  path: string;
  /** Set to true only after the endpoint is confirmed by KitShop documentation. */
  confirmed: boolean;
  note: string;
}

export const READ_ENDPOINTS = {
  salesByShops: {
    method: "GET",
    path: "/GetSalesbyShops",
    confirmed: false,
    note: "Существует в KitShop. Нужны: URL, параметры периода, пагинация, формат ответа, авторизация.",
  },
  shops: { method: "GET", path: "", confirmed: false, note: "Метод не известен — нужен справочник точек." },
  products: { method: "GET", path: "", confirmed: false, note: "Метод не известен — нужен справочник товаров." },
  stocks: { method: "GET", path: "", confirmed: false, note: "Метод не известен — нужны текущие остатки." },
} as const satisfies Record<string, ReadEndpoint>;

type EndpointName = keyof typeof READ_ENDPOINTS;

export class KitShopNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KitShopNotReadyError";
  }
}

export class KitShopReadOnlyClient {
  readonly #config: KitShopConfig;

  constructor(config: KitShopConfig = readKitShopConfig()) {
    this.#config = config;
  }

  async getSalesByShops(query: SalesQuery): Promise<KitShopSale[]> {
    const params: Record<string, string> = { from: query.from, to: query.to };
    if (query.shopIds?.length) params.shopIds = query.shopIds.join(",");
    return this.#read("salesByShops", params, z.array(KitShopSaleSchema));
  }

  async getShops(): Promise<KitShopShop[]> {
    return this.#read("shops", {}, z.array(KitShopShopSchema));
  }

  async getProducts(): Promise<KitShopProduct[]> {
    return this.#read("products", {}, z.array(KitShopProductSchema));
  }

  async getStocks(shopIds?: string[]): Promise<KitShopStock[]> {
    return this.#read("stocks", shopIds?.length ? { shopIds: shopIds.join(",") } : {}, z.array(KitShopStockSchema));
  }

  /** Private: the single place that talks to the network. GET only. */
  async #read<T>(name: EndpointName, params: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
    const ep: ReadEndpoint = READ_ENDPOINTS[name];
    if (!this.#config.enabled) throw new KitShopNotReadyError("KitShop отключён (KITSHOP_ENABLED != true).");
    if (!ep.confirmed || !ep.path) throw new KitShopNotReadyError(`Метод «${name}» не подтверждён документацией: ${ep.note}`);
    if (!this.#config.baseUrl) throw new KitShopNotReadyError("Не задан KITSHOP_API_URL.");
    if (ep.method !== "GET") throw new Error("Only GET requests are allowed to KitShop.");

    const url = new URL(ep.path, this.#config.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    // Authentication scheme is not confirmed yet — it will be added here once documented.
    const res = await this.#fetchWithRetry(url, { method: "GET", headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) throw new Error(`KitShop ${name}: HTTP ${res.status}`);
    return schema.parse(await res.json());
  }

  async #fetchWithRetry(url: URL, init: RequestInit, attempts = 3): Promise<Response> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        const res = await fetch(url, { ...init, signal: controller.signal });
        clearTimeout(timer);
        if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
        return res;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("KitShop request failed");
  }
}

/** Guard used by tests / health check: the public surface must contain read methods only. */
export function assertReadOnlySurface(): { ok: boolean; methods: string[] } {
  const methods = Object.getOwnPropertyNames(KitShopReadOnlyClient.prototype).filter((m) => m !== "constructor");
  const forbidden = methods.filter((m) => /^(create|update|delete|remove|post|put|patch|set|write|insert|upsert)/i.test(m));
  return { ok: forbidden.length === 0 && methods.every((m) => m.startsWith("get")), methods };
}
