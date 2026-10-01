import "server-only";
import type { NetworkSnapshot } from "@/lib/domain/types";
import { kitShopStatus } from "./config";
import { KitShopNotReadyError, READ_ENDPOINTS, assertReadOnlySurface } from "./kitshopClient";

export { KitShopReadOnlyClient, KitShopNotReadyError, READ_ENDPOINTS, assertReadOnlySurface } from "./kitshopClient";
export { kitShopStatus } from "./config";

/**
 * KitShop data source (Phase 2/3).
 * It will build a NetworkSnapshot from OUR database, filled by the incremental sync (lib/sync).
 * Until the API is documented it refuses to run — the app stays in MOCK mode.
 */
export class KitShopDataSource {
  readonly kind = "kitshop" as const;

  async snapshot(): Promise<NetworkSnapshot> {
    throw new KitShopNotReadyError(
      "KitShop-адаптер ещё не подключён: нужна подтверждённая документация API (см. docs/KITSHOP_API_REQUIREMENTS.md). Используйте DATA_SOURCE=mock.",
    );
  }
}

/** Diagnostics for the UI — never exposes credential values. */
export function kitShopDiagnostics() {
  return {
    status: kitShopStatus(),
    readOnlySurface: assertReadOnlySurface(),
    endpoints: Object.entries(READ_ENDPOINTS).map(([name, ep]) => ({
      name,
      method: `POST ${ep.path}`,
      confirmed: ep.confirmed,
      note: ep.note,
    })),
  };
}
