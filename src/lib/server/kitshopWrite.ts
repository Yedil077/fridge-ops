import "server-only";
import { DryRunWriteAdapter, MockWriteAdapter } from "../kitshop-ops/adapters";
import type { AdapterMode, KitShopWriteAdapter } from "../kitshop-ops/types";
import { readKitShopConfig, readKitShopWriteConfig, type KitShopWriteConfig } from "@/services/kitshop/config";
import { KitShopReadOnlyClient } from "@/services/kitshop/kitshopClient";
import { KitShopTransport } from "@/services/kitshop/transport";
import { KitShopLiveWriter } from "@/services/kitshop/writer";

/**
 * Chooses the write adapter for a shop (audit §4):
 *   live    — KITSHOP_ENABLED & KITSHOP_WRITE_ENABLED & !KITSHOP_WRITE_DRY_RUN & shop ∈ KITSHOP_WRITE_SHOPS
 *   dry-run — KITSHOP_WRITE_ENABLED, but dry-run is on or the shop is not allowlisted
 *   mock    — everything else (default: writes disabled) → fake KiT Shop, nothing leaves the server
 * Never all fridges at once: a shop must be listed explicitly to get real writes.
 */

interface Adapters {
  mock: MockWriteAdapter;
  dryRun: DryRunWriteAdapter;
  live: KitShopLiveWriter | null;
  gate: KitShopWriteConfig;
}

const g = globalThis as unknown as { __kitshopAdapters?: Adapters };

function adapters(): Adapters {
  if (!g.__kitshopAdapters) {
    const config = readKitShopConfig();
    const gate = readKitShopWriteConfig();
    const open = config.enabled && gate.writeEnabled && !gate.dryRun && gate.shops.length > 0;
    let live: KitShopLiveWriter | null = null;
    if (open) {
      // one transport = one RequestId sequence for reads and writes
      const transport = new KitShopTransport(config);
      live = new KitShopLiveWriter(config, gate, transport, new KitShopReadOnlyClient(config, transport));
      console.warn(`[kitshop] LIVE writes enabled for shops: ${gate.shops.join(", ")}`);
    }
    g.__kitshopAdapters = {
      mock: new MockWriteAdapter(Number(process.env.MOCK_KITSHOP_DELAY_MS ?? 700) || 0),
      dryRun: new DryRunWriteAdapter(),
      live,
      gate,
    };
  }
  return g.__kitshopAdapters;
}

export function adapterFor(shopId: string): KitShopWriteAdapter {
  const a = adapters();
  if (a.live && a.gate.shops.includes(shopId)) return a.live;
  // writes switched on but this shop not allowlisted (or dry-run) → log only, never fake success
  if (a.gate.writeEnabled) return a.dryRun;
  return a.mock;
}

/** Catalog writes (AddProduct) are company-wide: live only when the gate is open for at least one shop. */
export function catalogAdapter(): KitShopWriteAdapter {
  const a = adapters();
  if (a.live) return a.live;
  if (a.gate.writeEnabled) return a.dryRun;
  return a.mock;
}

export function mockAdapter(): MockWriteAdapter {
  return adapters().mock;
}

export function writeGate(): KitShopWriteConfig {
  return adapters().gate;
}

/** "not found in KiT Shop" means "not applied" — always for mock/dry-run, for live only after Phase D. */
export function trustAbsent(mode: AdapterMode): boolean {
  return mode !== "live" || adapters().gate.notesRoundTripVerified;
}

export function writeModeSummary() {
  const a = adapters();
  return {
    writeEnabled: a.gate.writeEnabled,
    dryRun: a.gate.dryRun,
    liveShops: a.live ? a.gate.shops : [],
    defaultMode: (a.gate.writeEnabled ? "dry-run" : "mock") as AdapterMode,
    timeoutMs: a.gate.timeoutMs,
  };
}
