import "server-only";
import { DryRunWriteAdapter, MockWriteAdapter } from "../kitshop-ops/adapters";
import type { AdapterMode, KitShopWriteAdapter, OpOrigin } from "../kitshop-ops/types";
import { readKitShopConfig, readKitShopWriteConfig, type KitShopConfig, type KitShopWriteConfig } from "@/services/kitshop/config";
import { KitShopReadOnlyClient } from "@/services/kitshop/kitshopClient";
import { KitShopTransport, type CallRecord } from "@/services/kitshop/transport";
import { KitShopLiveWriter } from "@/services/kitshop/writer";

/**
 * Chooses the write adapter for a shop (audit §4):
 *   live    — KITSHOP_ENABLED & KITSHOP_WRITE_ENABLED & !KITSHOP_WRITE_DRY_RUN & shop ∈ KITSHOP_WRITE_SHOPS
 *             AND (KITSHOP_WRITE_SCOPE=all OR the operation comes from the admin REAL WRITE TEST wizard)
 *   dry-run — KITSHOP_WRITE_ENABLED, but dry-run is on / the shop is not allowlisted / scope=test and a normal operation
 *   mock    — everything else (default: writes disabled) → fake KiT Shop, nothing leaves the server
 * Never all fridges at once: a shop must be listed explicitly to get real writes.
 *
 * ONE transport per process: reads and writes share a single, strictly increasing RequestId sequence.
 */

interface KitShopServer {
  config: KitShopConfig;
  gate: KitShopWriteConfig;
  /** "test" (default): only the REAL WRITE TEST wizard may write live; "all": every operation on allowlisted shops */
  scope: "test" | "all";
  transport: KitShopTransport;
  reader: KitShopReadOnlyClient;
  mock: MockWriteAdapter;
  dryRun: DryRunWriteAdapter;
  live: KitShopLiveWriter | null;
  /** last calls per method (diagnostics) */
  calls: Map<string, CallRecord>;
  lastOk: CallRecord | null;
  lastError: CallRecord | null;
}

const g = globalThis as unknown as { __kitshopServer?: KitShopServer };

/**
 * KiT Shop is used ONLY FOR READING unless KITSHOP_READ_ONLY=false is set explicitly.
 * In read-only mode the live writer is never constructed, so no code path can reach MakeFillUp / AddProduct.
 */
export function kitshopReadOnly(): boolean {
  return process.env.KITSHOP_READ_ONLY !== "false";
}

function server(): KitShopServer {
  if (!g.__kitshopServer) {
    const config = readKitShopConfig();
    const gate = readKitShopWriteConfig();
    const calls = new Map<string, CallRecord>();
    const s = {} as KitShopServer;
    const transport = new KitShopTransport(config, {
      signUpper: process.env.KITSHOP_SIGN_CASE === "upper",
      onCall: (r) => {
        calls.set(r.method, r);
        if (r.ok) s.lastOk = r;
        else s.lastError = r;
      },
    });
    const reader = new KitShopReadOnlyClient(config, transport);
    const open = !kitshopReadOnly() && config.enabled && gate.writeEnabled && !gate.dryRun && gate.shops.length > 0;
    const live = open ? new KitShopLiveWriter(config, gate, transport, reader) : null;
    if (live) console.warn(`[kitshop] LIVE writes enabled for shops: ${gate.shops.join(", ")} (scope ${process.env.KITSHOP_WRITE_SCOPE === "all" ? "all" : "test"})`);
    Object.assign(s, {
      config,
      gate,
      scope: process.env.KITSHOP_WRITE_SCOPE === "all" ? "all" : "test",
      transport,
      reader,
      mock: new MockWriteAdapter(Number(process.env.MOCK_KITSHOP_DELAY_MS ?? 700) || 0),
      dryRun: new DryRunWriteAdapter(),
      live,
      calls,
      lastOk: null,
      lastError: null,
    });
    g.__kitshopServer = s;
  }
  return g.__kitshopServer;
}

export function adapterFor(shopId: string, origin: OpOrigin = "app"): KitShopWriteAdapter {
  const a = server();
  if (a.live && a.gate.shops.includes(shopId) && (a.scope === "all" || origin === "write-test")) return a.live;
  // writes switched on but not allowed live here → log only, never fake success
  if (a.gate.writeEnabled) return a.dryRun;
  return a.mock;
}

/** Catalog writes (AddProduct) are company-wide: live only with scope=all. */
export function catalogAdapter(): KitShopWriteAdapter {
  const a = server();
  if (a.live && a.scope === "all") return a.live;
  if (a.gate.writeEnabled) return a.dryRun;
  return a.mock;
}

export function mockAdapter(): MockWriteAdapter {
  return server().mock;
}

export function writeGate(): KitShopWriteConfig {
  return server().gate;
}

/** The read client sharing the process-wide transport. */
export function kitshopReader(): KitShopReadOnlyClient {
  return server().reader;
}

export function kitshopTransport(): KitShopTransport {
  return server().transport;
}

export function kitshopServerInfo() {
  const s = server();
  return { config: s.config, gate: s.gate, scope: s.scope, liveOpen: !!s.live, calls: s.calls, lastOk: s.lastOk, lastError: s.lastError };
}

/**
 * "not found in KiT Shop" means "not applied" only for mock / dry-run.
 * LIVE: a sent write whose UUID is not found in GetFillUps goes to REQUIRES_REVIEW — a person decides, never an automatic re-send.
 */
export function trustAbsent(mode: AdapterMode): boolean {
  return mode !== "live";
}

export function writeModeSummary() {
  const a = server();
  return {
    readOnly: kitshopReadOnly(),
    writeEnabled: a.gate.writeEnabled && !kitshopReadOnly(),
    dryRun: a.gate.dryRun,
    liveShops: a.live ? a.gate.shops : [],
    scope: a.scope,
    defaultMode: (a.gate.writeEnabled ? "dry-run" : "mock") as AdapterMode,
    timeoutMs: a.gate.timeoutMs,
  };
}
