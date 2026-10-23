import "server-only";
import { Pool } from "pg";
import type { Fridge, NetworkSnapshot } from "../domain/types";
import { KsDataset } from "../kitshop-data/dataset";
import { FileKsRepo, PgKsRepo, type KsRepo } from "../kitshop-data/repo";
import { buildKitShopSnapshot } from "../kitshop-data/snapshot";
import { KitShopSync, syncOptionsFromEnv, type SyncDeps, type SyncOptions, type TickResult } from "../kitshop-data/sync";
import { configuredFridges } from "../simulator/model";
import { dayNumber, wallClockNow } from "../time";
import { KitShopNotReadyError } from "@/services/kitshop/kitshopClient";
import { kitshopReader } from "./kitshopWrite";

/**
 * Real KiT Shop data for every screen (DATA_SOURCE=kitshop). READ ONLY.
 *  • our PostgreSQL (ks_* tables) is the cache: screens always read it, so a KiT Shop outage shows CACHE, not an error;
 *  • a background loop syncs every 5 minutes; while the 180-day backfill / receipt details are behind it runs every 20 s;
 *  • the simulator is never used here.
 */

const TZ = process.env.APP_TIMEZONE || "Asia/Almaty";
const SYNC_EVERY_MS = 5 * 60_000;
const BACKLOG_EVERY_MS = 20_000;
/** no fresh KiT Shop data for this long → the label switches to CACHE */
export const STALE_AFTER_MS = 15 * 60_000;

export type DataLabel = "KITSHOP REAL" | "CACHE" | "SIMULATOR" | "LOADING" | "UNAVAILABLE";

export interface LiveStatus {
  label: DataLabel;
  repo: KsRepo["kind"];
  lastSuccessAt: number | null;
  lastCatalogSyncAt: number | null;
  lastStockSyncAt: number | null;
  lastSalesSyncAt: number | null;
  lastFillupsSyncAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  counts: ReturnType<KsDataset["counts"]>;
  backlog: { undetailed: number; backfillDaysLeft: number };
  progress: ReturnType<KitShopSync["progress"]>;
  errors24h: { count: number; last: { at: number; step: string; error: string }[] };
  categorizedBy: { group: number; name: number } | null;
  lastTick: TickResult | null;
  running: boolean;
  now: number;
  /** our configured points ↔ KiT Shop shops */
  fridges: {
    id: string;
    name: string;
    shopId: string;
    inKitShop: boolean;
    stockItems: number;
    stockAt: number | null;
    /** receipts today / units today (units only from receipts already detailed through GetSaleById) */
    receiptsToday: number;
    unitsToday: number;
    /** last 60 minutes */
    receiptsLastHour: number;
    unitsLastHour: number;
    lastSaleAt: number | null;
  }[];
}

function createRepo(): KsRepo {
  const url = process.env.DATABASE_URL;
  const driver = process.env.STORE_DRIVER ?? (url ? "postgres" : "file");
  if (driver === "postgres" && url) {
    const pool = new Pool({
      connectionString: url,
      max: 3,
      connectionTimeoutMillis: 15_000,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: process.env.DATABASE_SSL_STRICT !== "false" } : undefined,
    });
    return new PgKsRepo(pool);
  }
  return new FileKsRepo();
}

export class KitShopLive {
  readonly ds = new KsDataset();
  readonly repo: KsRepo;
  readonly sync: KitShopSync;
  private loaded: Promise<void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cache: { key: string; snap: NetworkSnapshot } | null = null;
  private configured: Fridge[];

  private now: () => number;

  /** deps are injectable for tests (PGlite repo, fake reader, fixed clock); production uses env + the shared transport */
  constructor(deps: { repo?: KsRepo; reader?: SyncDeps["reader"]; now?: () => number; options?: Partial<SyncOptions>; sleep?: SyncDeps["sleep"] } = {}) {
    this.now = deps.now ?? (() => wallClockNow(TZ));
    this.repo = deps.repo ?? createRepo();
    this.configured = configuredFridges(dayNumber(this.now()));
    const offsetMin = Number(process.env.KITSHOP_TIME_OFFSET_MINUTES ?? 0) || 0;
    this.sync = new KitShopSync({
      reader: deps.reader ?? kitshopReader(),
      repo: this.repo,
      ds: this.ds,
      now: this.now,
      ourShopIds: this.configured.map((f) => f.externalId).filter((id) => /^\d+$/.test(id)),
      timeOffsetMs: offsetMin * 60_000,
      // KITSHOP_BACKFILL_DAYS / _CONCURRENCY / _DELAY_MS — gentle defaults (180 days, 1 request at a time, 300 ms pause)
      options: { ...syncOptionsFromEnv(), ...(deps.options ?? {}) },
      sleep: deps.sleep,
    });
    this.loaded = this.repo.load(this.ds).catch((e) => {
      console.error("[kitshop-sync] could not load the cache:", e instanceof Error ? e.message : e);
    });
  }

  /** resolves when the cache (ks_* tables) has been loaded */
  async ready() {
    await this.loaded;
  }

  /** Starts the background loop (first tick right after the cache is loaded). */
  start() {
    this.started = true;
    void this.loaded.then(() => this.schedule(1_000));
  }

  private started = false;

  private schedule(ms: number) {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.runTick(), ms);
    this.timer.unref?.();
  }

  private async runTick(force: { catalog?: boolean } = {}): Promise<TickResult> {
    await this.loaded;
    const res = await this.sync.tick(force);
    const failed = res.steps.filter((s) => !s.ok);
    console.info(
      `[kitshop-sync] ${res.ok ? "ok" : "partial"} in ${res.ms} ms · ${res.steps.map((s) => `${s.step}=${s.ok ? s.count : "ERR"}`).join(" ")} · backlog ${res.backlog.undetailed} receipts, ${res.backlog.backfillDaysLeft} days`,
    );
    if (failed.length) console.warn("[kitshop-sync] errors:", failed.map((s) => `${s.step}: ${s.error}`).join("; "));
    const behind = res.backlog.undetailed > 0 || res.backlog.backfillDaysLeft > 0;
    this.schedule(behind && res.ok ? BACKLOG_EVERY_MS : SYNC_EVERY_MS);
    return res;
  }

  /** "Синхронизировать сейчас" (admin) and the keep-alive health ping. */
  async syncNow(force: { catalog?: boolean } = {}) {
    return this.runTick(force);
  }

  /** Health ping: trigger a tick if the loop fell asleep (free hosting pauses timers while idle). */
  nudge() {
    const last = this.ds.state.lastSalesSyncAt;
    if (!this.sync.running && (last === null || this.now() - last > SYNC_EVERY_MS + 60_000)) void this.runTick();
  }

  label(now = this.now()): DataLabel {
    const st = this.ds.state;
    // the first sync has not read stock / receipts yet (catalog alone is not data)
    if (st.lastSuccessAt === null) return st.lastError ? "UNAVAILABLE" : "LOADING";
    const failedLast = this.sync.lastTick ? !this.sync.lastTick.steps.some((s) => s.ok && (s.step.startsWith("GetShopStocks") || s.step === "GetSales (новые)")) : false;
    return now - st.lastSuccessAt > STALE_AFTER_MS || failedLast ? "CACHE" : "KITSHOP REAL";
  }

  /** Snapshot for the engine. Empty cache → "data is loading" (never the simulator). */
  async snapshot(): Promise<NetworkSnapshot> {
    await this.loaded;
    // cold start: nothing is shown until the first sync really read stock / receipts (persisted, so a restart shows the cache at once)
    if (this.ds.state.lastSuccessAt === null) {
      const err = this.ds.state.lastError;
      throw new KitShopNotReadyError(
        err
          ? `ДАННЫЕ НЕДОСТУПНЫ: KiT Shop не ответил при первой синхронизации (${err}). Данные симулятора не подставляются.`
          : "Данные KiT Shop загружаются (первая синхронизация). Обновите страницу через минуту. Данные симулятора НЕ подставляются.",
      );
    }
    const now = this.now();
    const key = `${this.ds.version}:${Math.floor(now / 60_000)}`;
    if (this.cache?.key === key) return this.cache.snap;
    const snap = buildKitShopSnapshot(this.ds, this.configured, now);
    this.cache = { key, snap };
    return snap;
  }

  async status(): Promise<LiveStatus> {
    await this.loaded;
    const st = this.ds.state;
    const lastSale = new Map<string, number>();
    const today = new Map<string, { receipts: number; units: number }>();
    const hour = new Map<string, { receipts: number; units: number }>();
    const nowMs = this.now();
    const todayDay = dayNumber(nowMs);
    for (const s of this.ds.sales.values()) {
      if (s.soldAt > (lastSale.get(s.shopId) ?? 0)) lastSale.set(s.shopId, s.soldAt);
      if (s.soldAt > nowMs - 3_600_000 && s.soldAt <= nowMs) {
        const h = hour.get(s.shopId) ?? { receipts: 0, units: 0 };
        h.receipts++;
        for (const p of this.ds.positions.get(s.saleId) ?? []) h.units += p.qty;
        hour.set(s.shopId, h);
      }
      if (dayNumber(s.soldAt) !== todayDay) continue;
      const t = today.get(s.shopId) ?? { receipts: 0, units: 0 };
      t.receipts++;
      for (const p of this.ds.positions.get(s.saleId) ?? []) t.units += p.qty;
      today.set(s.shopId, t);
    }
    return {
      label: this.label(),
      repo: this.repo.kind,
      lastSuccessAt: st.lastSuccessAt,
      lastCatalogSyncAt: st.lastCatalogSyncAt,
      lastStockSyncAt: st.lastStockSyncAt,
      lastSalesSyncAt: st.lastSalesSyncAt,
      lastFillupsSyncAt: st.lastFillupsSyncAt,
      lastError: st.lastError,
      lastErrorAt: st.lastErrorAt,
      counts: this.ds.counts(this.now()),
      backlog: this.sync.backlog(),
      progress: this.sync.progress(),
      errors24h: (() => {
        const list = (st.errors ?? []).filter((e) => e.at > this.now() - 86_400_000);
        return { count: list.length, last: list.slice(-5).reverse() };
      })(),
      categorizedBy: this.cache?.snap.categorizedBy ?? null,
      lastTick: this.sync.lastTick,
      running: this.sync.running,
      now: this.now(),
      fridges: this.configured.map((f) => ({
        id: f.id,
        name: f.name,
        shopId: f.externalId,
        inKitShop: this.ds.shops.has(f.externalId),
        stockItems: [...(this.ds.stock.get(f.externalId)?.values() ?? [])].reduce((a, b) => a + b, 0),
        stockAt: this.ds.stockAt.get(f.externalId) ?? null,
        receiptsToday: today.get(f.externalId)?.receipts ?? 0,
        unitsToday: Math.round(today.get(f.externalId)?.units ?? 0),
        receiptsLastHour: hour.get(f.externalId)?.receipts ?? 0,
        unitsLastHour: Math.round(hour.get(f.externalId)?.units ?? 0),
        lastSaleAt: lastSale.get(f.externalId) ?? null,
      })),
    };
  }
}

const g = globalThis as unknown as { __kitshopLive?: KitShopLive };

/** One live data service per server process (only in DATA_SOURCE=kitshop). */
export function kitshopLive(): KitShopLive {
  if (!g.__kitshopLive) {
    g.__kitshopLive = new KitShopLive();
    g.__kitshopLive.start();
  }
  return g.__kitshopLive;
}

export function kitshopLiveStarted(): KitShopLive | null {
  return g.__kitshopLive ?? null;
}
