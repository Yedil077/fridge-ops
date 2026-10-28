import "server-only";
import { ENGINE_CONFIG } from "../config/engine";
import { emptyShelfLife, type ShelfLifeSettings } from "../config/shelfLife";
import { FORECAST_MODE_IDS, type ForecastMode, type Mission, type NetworkSnapshot } from "../domain/types";
import { DEFAULT_UNTIL_MINUTE, horizonWindow } from "../engine/recommend";
import { analyze, type AnalysisResult } from "../engine/analysis";
import { buildTravelMatrix } from "../engine/distance";
import { applyLearning, evaluateMission, isDue } from "../engine/feedback";
import { createStore, emptyState, newPlayer, type AppState, type FridgeSettings, type Player, type StateStore } from "../store/appStore";
import { deliver, detectAlerts } from "./notifications";
import { bootstrapUsers } from "./users";
import { Simulator } from "../simulator/simulator";
import { dayNumber, fmtHM, minuteOfDay, MINUTE_MS, wallClockNow, weekdayOf } from "../time";
import { kitshopLive, kitshopLiveStarted, type DataLabel } from "./kitshopLive";
import { OpsService } from "../kitshop-ops/service";
import { resolveMapping, type CatalogItem, type MappingResult } from "../kitshop-ops/mapping";
import type { KsOperation, OpLine, OpType } from "../kitshop-ops/types";
import { adapterFor, catalogAdapter, kitshopReadOnly, mockAdapter, trustAbsent, writeGate } from "./kitshopWrite";
import { addProductBody } from "../kitshop-ops/adapters";
import type { CatalogProductInput } from "../kitshop-ops/types";
import { newId } from "./pin";
import { readKitShopConfig } from "@/services/kitshop/config";
import { autoUnusedReport } from "./unusedReport";

/**
 * Server runtime: owns the data source (real KiT Shop copy in KITSHOP mode, simulator only in MOCK/dev mode), our app state,
 * the analysis cache, the mission/route workflow and gamification. One instance per server process.
 */

export interface CompleteItem {
  lineIndex: number;
  productId: string;
  /** actually delivered */
  qty: number;
  /** chosen at pick-up (partial is normal) */
  selectedQty?: number;
  /** optional: no_stock | not_needed | low_left | other */
  skipReason?: string;
  /** "Есть только N" — the fridge physically had less; not the employee's fault. */
  unavailable?: boolean;
}

export const FORECAST_MODES: ForecastMode[] = FORECAST_MODE_IDS;

export type MissionAction =
  | { action: "accept" }
  | { action: "start" }
  | { action: "complete"; quantities?: Record<string, number>; items?: CompleteItem[] }
  | { action: "skip"; reason?: string };

export interface XpGain {
  amount: number;
  points: number;
  reason: string;
}

export interface CompletionImpact {
  savedSales: number;
  wasteReduced: number;
  unlockedRewards: string[];
  unlockedAchievements: string[];
}

const TZ = process.env.APP_TIMEZONE || "Asia/Almaty";

/** XP / points / rewards / achievements are switched off (a later, separate update). */
const GAMIFICATION = false;

/**
 * Free Render stops an idle service after ~15 min without inbound requests: the 5-minute KiT Shop sync stops with it, and the
 * phone app then opens while the server is still waking up (30–60 s) and shows "нет связи".
 * While the server is up it pings its own public URL every 10 min (RENDER_EXTERNAL_URL is set by Render; KEEP_ALIVE_URL
 * overrides it, KEEP_ALIVE=false switches it off). An external monitor on /api/health is still the backup: a server that
 * is already asleep cannot wake itself.
 */
function startKeepAlive() {
  const base = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL;
  if (!base || process.env.KEEP_ALIVE === "false") return;
  const url = `${base.replace(/\/$/, "")}/api/health`;
  setInterval(() => {
    fetch(url, { cache: "no-store" }).catch((e) => console.warn("[apps-holodosov] keep-alive ping failed:", e instanceof Error ? e.message : e));
  }, 10 * 60_000).unref?.();
  console.info(`[apps-holodosov] keep-alive: ${url} every 10 min`);
}

class Runtime {
  state: AppState;
  sim: Simulator | null = null;
  readonly mode: "mock" | "kitshop";
  /**
   * DATA_SOURCE=kitshop_shadow: the real KiT Shop sync and a parallel forecast run in the background,
   * screens still show the simulator; admins compare real vs mock. Safe first step before DATA_SOURCE=kitshop.
   */
  readonly shadow: boolean;
  readonly store: StateStore;
  private cache = new Map<ForecastMode, { key: string; result: AnalysisResult }>();
  /** KiT Shop is READ ONLY (default). Loads / unloads / write-offs / transfer legs / product creation are refused. */
  readonly readOnly = kitshopReadOnly();
  private saving: Promise<void> | null = null;
  private dirty = false;
  private catchingUp = false;
  /** KiT Shop write operations (load / unload / write-off / transfer legs) */
  readonly ops: OpsService;

  private constructor(state: AppState, store: StateStore) {
    this.mode = process.env.DATA_SOURCE === "kitshop" ? "kitshop" : "mock";
    this.shadow = process.env.DATA_SOURCE === "kitshop_shadow";
    this.state = state;
    this.store = store;
    // getters, not values: `reseed` replaces this.state
    const self = this;
    this.ops = new OpsService({
      get state() {
        return self.state;
      },
      adapterFor,
      isPaused: () => !!this.state.kitshopAdmin?.writesPaused,
      flush: () => this.flushNow(),
      // operations are stamped with REAL wall-clock time (KiT Shop reconciliation windows depend on it), not simulator time
      now: () => wallClockNow(TZ),
      save: () => this.save(),
      newId,
      timeoutMs: writeGate().timeoutMs,
      trustAbsent,
      verifyWindowMs: 5 * 60_000,
      onConfirmed: (op) => this.applyConfirmedToSim(op),
    });
  }

  /** Loads OUR state from the configured store (PostgreSQL in production) and prepares the runtime. */
  static async create(): Promise<Runtime> {
    const store = await createStore();
    console.info(`[apps-holodosov] starting · store=${store.kind} · data=${process.env.DATA_SOURCE ?? "mock"}`);
    const rt = new Runtime(await store.load(), store);
    console.info(`[apps-holodosov] state loaded · users=${rt.state.users.length} · missions=${rt.state.missions.length}`);
    try {
      const created = bootstrapUsers(rt.state);
      if (created.length) console.info(`[apps-holodosov] created initial accounts: ${created.join(", ")}`);
    } catch (e) {
      // a bad ADMIN_LOGIN / ADMIN_PIN must not take the whole service down
      console.error("[apps-holodosov] could not create the first administrator:", e instanceof Error ? e.message : e, "— check ADMIN_LOGIN (2–32 chars) and ADMIN_PIN (4–8 digits)");
    }
    if (rt.mode === "mock") rt.ensureSim();
    if (rt.mode === "kitshop" || rt.shadow) {
      const c = readKitShopConfig();
      // what the server sees (never the values): helps when Render variables are missing or misspelled
      console.info(
        `[apps-holodosov] KiT Shop reading ${c.enabled ? "ON" : "OFF"} · company id ${c.companyId ? "set" : "MISSING"} · login ${c.login ? "set" : "MISSING"} · password ${c.password ? "set" : "MISSING"} · ${new URL(c.baseUrl).host}`,
      );
    }
    // starts the 5-minute read-only sync; the nightly analytics job uses the shelf lives from Настройки
    if (rt.mode === "kitshop" || rt.shadow) kitshopLive().setShelfLifeProvider(() => rt.shelfLife());
    // in every mode: a sleeping free server makes the phone app open on "нет связи" while it wakes up (30–60 s)
    startKeepAlive();
    rt.save();
    await rt.saving;
    // "что удалить из KiT Shop" Excel: rebuilt by the server once a day (read only), stored in the database
    setInterval(() => {
      autoUnusedReport().catch((e) => console.error("[apps-holodosov] automatic report failed to start:", e instanceof Error ? e.message : e));
    }, 60_000).unref?.();
    // background pass for KiT Shop write operations — never in read-only mode (nothing may be sent to KiT Shop)
    if (!rt.readOnly)
      setInterval(() => {
        rt.ops.tick().catch((e) => console.error("[kitshop-ops] tick failed", e));
      }, 60_000).unref?.();
    if (rt.shadow) console.info("[apps-holodosov] SHADOW MODE: real KiT Shop data is synced in the background, screens show the simulator");
    console.info(`[apps-holodosov] KiT Shop ${rt.readOnly ? "READ ONLY" : "writes allowed (KITSHOP_READ_ONLY=false)"}`);
    return rt;
  }

  private ensureSim() {
    if (this.state.sim) {
      this.sim = new Simulator(this.state.sim);
    } else {
      const seed = Number(process.env.SIM_SEED ?? 42) || 42;
      this.sim = Simulator.create(seed, dayNumber(wallClockNow(TZ)));
      this.state.sim = this.sim.state;
      this.runHourlySync();
      this.save();
    }
  }

  /** Coalesced async persistence: many mutations in a tick → one write. */
  save() {
    if (this.sim) this.state.sim = this.sim.state;
    this.dirty = true;
    if (!this.saving) this.saving = this.flush();
  }

  private async flush() {
    while (this.dirty) {
      this.dirty = false;
      try {
        await this.store.save(this.state);
      } catch (e) {
        console.error("[apps-holodosov] failed to persist state", e);
      }
    }
    this.saving = null;
  }

  async flushNow() {
    this.save();
    await this.saving;
  }

  /**
   * The simulated clock follows the REAL clock by default (set SIM_REALTIME=false to freeze it for tests).
   * DEV "+1 час" can move ahead; the clock then waits until real time catches up, or press "Сейчас".
   */
  private catchUpRealtime() {
    if (process.env.SIM_REALTIME === "false" || !this.sim || this.catchingUp) return;
    const target = wallClockNow(TZ);
    const behind = Math.floor((target - this.sim.now) / MINUTE_MS);
    if (behind < 15) return;
    this.catchingUp = true;
    try {
      // Must stay cheap: on a sleeping free server the first request pays for the catch-up.
      if (dayNumber(target) !== this.sim.state.day) {
        // slept into a new day: close the old one (evaluate what we can) and start today directly
        const old = this.simSnapshot();
        this.evaluateDue(old, true);
        for (const m of this.state.missions)
          if (m.status === "NEW" || m.status === "ACCEPTED" || m.status === "IN_PROGRESS") m.status = "EXPIRED";
        this.dayBonus(old.today.day);
        this.sim = Simulator.create(this.sim.state.seed, dayNumber(target), minuteOfDay(target) - (minuteOfDay(target) % 15));
        this.state.sim = this.sim.state;
        this.cache.clear();
      } else {
        // same day: play the sales, but analyse only once at the end
        this.advance(behind - (behind % 15), false);
      }
      this.runHourlySync();
      this.save();
    } finally {
      this.catchingUp = false;
    }
  }

  // ───────────────────────── data ─────────────────────────

  /** Applies Admin settings (display names, schedule, proximity) on top of the source data. */
  private withSettings(snap: NetworkSnapshot): NetworkSnapshot {
    const st = this.state.fridgeSettings;
    const hasOverrides = Object.keys(st).length > 0 || Object.keys(this.state.travelOverrides).length > 0;
    if (!hasOverrides) return snap;
    const fridges = snap.fridges.map((f) => {
      const o = st[f.id];
      if (!o) return f;
      return {
        ...f,
        name: o.displayName?.trim() || f.name,
        shortName: o.shortName?.trim() || o.displayName?.trim() || f.shortName,
        location: o.location?.trim() || f.location,
        priority: o.priority ?? f.priority,
        proximityGroup: o.proximityGroup === undefined ? f.proximityGroup : o.proximityGroup,
        transferGroup: o.transferGroup === undefined ? f.transferGroup : o.transferGroup,
        workingDays: o.workingDays?.length ? o.workingDays : f.workingDays,
        openingMinute: o.openingMinute ?? f.openingMinute,
        closingMinute: o.closingMinute ?? f.closingMinute,
      };
    });
    return {
      ...snap,
      fridges,
      travelMinutes: buildTravelMatrix(fridges, this.state.travelOverrides),
      version: `${snap.version}:s${this.state.settingsVersion}`,
    };
  }

  async snapshot(): Promise<NetworkSnapshot> {
    this.catchUpRealtime();
    if (this.mode === "mock" && this.sim) return this.withSettings(this.sim.snapshot());
    // real KiT Shop copy from our database; never the simulator
    return this.withSettings(await kitshopLive().snapshot());
  }

  /** Label for every screen: KITSHOP REAL, CACHE (KiT Shop stale/unreachable — our database), SIMULATOR (dev only). */
  dataStatus(): { label: DataLabel; lastSuccessAt: number | null } {
    if (this.mode === "mock") return { label: "SIMULATOR", lastSuccessAt: null };
    const live = kitshopLive();
    return { label: live.label(), lastSuccessAt: live.ds.state.lastSuccessAt };
  }

  /**
   * Admin comparison (shadow mode): the real KiT Shop snapshot + a forecast built on it in parallel vs the simulator
   * the users see. Nothing of it is shown to users or stored in missions.
   */
  async shadowCompare() {
    if (this.mode !== "mock" || !this.shadow) return null;
    const real = await kitshopLive()
      .snapshot()
      .then((s) => this.withSettings(s))
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    const mock = await this.analysis("realtime");
    if (typeof real === "string") return { ready: false as const, message: real };
    const realResult = analyze(real, emptyState().learning, [], "realtime", this.untilMinute());
    const sum = (r: AnalysisResult, f: number, k: "expected2h" | "salesLastHour") => Math.round(r.forecasts[f].categories.reduce((a, c) => a + c[k], 0) * 10) / 10;
    const mockIdx = new Map(mock.snap.fridges.map((f, i) => [f.externalId, i]));
    const rows = real.fridges.map((f, i) => {
      const m = mockIdx.get(f.externalId);
      return {
        shopId: f.externalId,
        name: f.name,
        real: { stock: realResult.forecasts[i].totalStock, salesToday: realResult.forecasts[i].salesToday, lastHour: sum(realResult, i, "salesLastHour"), expected2h: sum(realResult, i, "expected2h"), status: realResult.forecasts[i].status },
        mock: m === undefined ? null : { stock: mock.result.forecasts[m].totalStock, salesToday: mock.result.forecasts[m].salesToday, expected2h: sum(mock.result, m, "expected2h"), status: mock.result.forecasts[m].status },
      };
    });
    return {
      ready: true as const,
      at: real.now,
      products: real.products.length,
      categorizedBy: real.categorizedBy ?? null,
      realRecommendations: realResult.drafts.length,
      mockRecommendations: mock.result.drafts.length,
      rows,
    };
  }

  private assertWritable(what: string) {
    if (this.readOnly) throw new HttpError(403, `${what}: KiT Shop подключён только для чтения. Изменения в KiT Shop через Apps Холодосов отключены.`);
  }

  private simSnapshot(): NetworkSnapshot {
    return this.withSettings(this.requireSim().snapshot());
  }

  private activeMissions(): Mission[] {
    return this.state.missions.filter((m) => m.status === "ACCEPTED" || m.status === "IN_PROGRESS");
  }

  /** The selected forecast horizon really changes the engine (REAL TIME, +1 Ч, +2 Ч, ДО HH:MM, ДО КОНЦА АКТИВНОСТИ). */
  private analysisFor(snap: NetworkSnapshot, mode: ForecastMode = "realtime"): AnalysisResult {
    const active = this.activeMissions();
    const until = this.untilMinute();
    const shelfLife = this.state.shelfLife ?? emptyShelfLife();
    const key = `${snap.version}|${until}|${JSON.stringify(shelfLife)}|${JSON.stringify(this.state.learning).length}|${active.map((m) => m.id + m.status).join(",")}`;
    const hit = this.cache.get(mode);
    if (hit?.key === key) return hit.result;
    const result = analyze(snap, this.state.learning, active, mode, until, { shelfLife });
    this.cache.set(mode, { key, result });
    return result;
  }

  async analysis(mode: ForecastMode = "realtime"): Promise<{ snap: NetworkSnapshot; result: AnalysisResult }> {
    const snap = await this.snapshot();
    return { snap, result: this.analysisFor(snap, this.effectiveMode(mode, snap)) };
  }

  /** Clock time of the user mode "ДО HH:MM" (Настройки, default 20:00). Not an assumption about closing hours. */
  untilMinute(): number {
    return this.state.untilMinute ?? DEFAULT_UNTIL_MINUTE;
  }

  untilTime(): string {
    return fmtHM(this.untilMinute());
  }

  shelfLife(): ShelfLifeSettings {
    return this.state.shelfLife ?? emptyShelfLife();
  }

  setShelfLife(next: ShelfLifeSettings) {
    this.state.shelfLife = next;
    this.cache.clear();
    this.save();
    // the norms depend on the shelf life: the analytics job runs again (in the background)
    const live = kitshopLiveStarted();
    if (live) void live.runAnalyticsNow("изменены сроки годности");
  }

  setUntilMinute(minute: number) {
    this.state.untilMinute = Math.max(0, Math.min(1439, Math.round(minute)));
    this.cache.clear();
    this.save();
  }

  /** "ДО HH:MM" after that time falls back to REAL TIME (the UI says the horizon has passed). */
  effectiveMode(mode: ForecastMode, snap: NetworkSnapshot): ForecastMode {
    return mode === "until20" && this.untilPassed(snap) ? "realtime" : mode;
  }

  /** Has the "ДО HH:MM" horizon already passed for the current time? */
  untilPassed(snap: NetworkSnapshot): boolean {
    return horizonWindow("until20", minuteOfDay(snap.now), { untilMinute: this.untilMinute() }).passed;
  }

  /** Current display names (Admin can rename fridges at any time). */
  names(snap: NetworkSnapshot): Record<string, string> {
    return Object.fromEntries(snap.fridges.map((f) => [f.id, f.name]));
  }

  // ───────────────────────── hourly analysis → missions ─────────────────────────

  private runHourlySync(): Mission[] {
    if (!this.sim) return [];
    const snap = this.simSnapshot();
    return this.createMissions(snap);
  }

  async runHourly(): Promise<Mission[]> {
    const snap = await this.snapshot();
    const created = this.createMissions(snap);
    this.save();
    return created;
  }

  /** Replaces untouched NEW missions with the fresh top list — one list per forecast mode. */
  private createMissions(snap: NetworkSnapshot): Mission[] {
    for (const m of this.state.missions) if (m.status === "NEW") m.status = "EXPIRED";
    // "ДО HH:MM" after that time has no horizon of its own → no separate mission list
    const modes = FORECAST_MODES.filter((m) => m !== "until20" || !this.untilPassed(snap));
    const drafts = modes.flatMap((mode) => this.analysisFor(snap, mode).drafts);
    const created: Mission[] = drafts.map((d) => {
      this.state.missionSeq += 1;
      return {
        ...d,
        id: `M-${this.state.missionSeq}`,
        number: this.state.missionSeq,
        createdAt: snap.now,
        analysisAt: snap.now,
        status: "NEW",
        acceptedAt: null,
        acceptedBy: null,
        startedAt: null,
        completedAt: null,
        completedBy: null,
        skippedAt: null,
        skipReason: null,
        evaluation: null,
        acceptance: null,
        xpAwarded: 0,
        pointsAwarded: 0,
      };
    });
    this.state.missions.push(...created);
    this.state.lastAnalysisAt = snap.now;
    // important alerts only (future push notifications)
    for (const n of detectAlerts(snap, this.analysisFor(snap, "realtime"), this.state, created)) {
      this.state.notifications.push(n);
      void deliver(n, this.state.devices).then(() => this.save());
    }
    return created;
  }

  /** Lazy scheduler: if the last analysis is older than the interval, run it now. */
  async ensureFreshAnalysis(): Promise<void> {
    const snap = await this.snapshot();
    const last = this.state.lastAnalysisAt;
    if (last === null || snap.now - last >= ENGINE_CONFIG.analysisIntervalMinutes * MINUTE_MS || dayNumber(last) !== dayNumber(snap.now)) {
      this.createMissions(snap);
      this.save();
    }
  }

  // ───────────────────────── gamification ─────────────────────────

  player(user: string): Player {
    if (!this.state.players[user]) this.state.players[user] = newPlayer(user);
    return this.state.players[user];
  }

  private now(): number {
    return this.sim?.now ?? wallClockNow(TZ);
  }

  private award(user: string, amount: number, points: number, reason: string, missionId: string | null): XpGain {
    if (!GAMIFICATION) return { amount: 0, points: 0, reason };
    const p = this.player(user);
    p.xp += amount;
    p.points += points;
    this.state.xpEvents.push({ at: this.now(), user, amount, points, reason, missionId });
    this.checkRewards(user);
    return { amount, points, reason };
  }

  /** Unlocks reward milestones by lifetime points. Never hands out anything by itself. */
  private checkRewards(user: string): string[] {
    if (!GAMIFICATION) return [];
    const p = this.player(user);
    const unlocked: string[] = [];
    for (const r of ENGINE_CONFIG.rewards) {
      if (p.points < r.points) continue;
      if (this.state.rewardClaims.some((c) => c.user === user && c.milestoneId === r.id)) continue;
      this.state.rewardClaims.push({
        id: `R-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        user,
        milestoneId: r.id,
        title: r.title,
        points: r.points,
        unlockedAt: this.now(),
        issuedAt: null,
        issuedBy: null,
      });
      unlocked.push(r.title);
    }
    return unlocked;
  }

  private unlockAchievements(user: string): string[] {
    if (!GAMIFICATION) return [];
    const p = this.player(user);
    const got: string[] = [];
    const progress: Record<string, number> = {
      firefighter: p.counters.hotStockoutsPrevented,
      "waste-saver": p.counters.wasteSaved,
      "perfect-route": p.counters.perfectRoutesInRow,
      "fast-response": p.counters.fastUrgent,
    };
    for (const a of ENGINE_CONFIG.achievements) {
      if (p.achievements[a.id]) continue;
      if ((progress[a.id] ?? 0) >= a.target) {
        p.achievements[a.id] = this.now();
        got.push(`${a.emoji} ${a.title}`);
      }
    }
    return got;
  }

  rewardIssue(claimId: string, admin: string) {
    const c = this.state.rewardClaims.find((x) => x.id === claimId);
    if (!c) throw new HttpError(404, "Награда не найдена");
    if (c.issuedAt) throw new HttpError(409, "Уже выдано");
    c.issuedAt = Date.now();
    c.issuedBy = admin;
    this.save();
    return c;
  }

  // ───────────────────────── feedback ─────────────────────────

  private evaluateDue(snap: NetworkSnapshot, force = false) {
    const X = ENGINE_CONFIG.xp;
    for (const m of this.state.missions) {
      if (m.status !== "COMPLETED" || m.evaluation) continue;
      if (!force && !isDue(m, snap.now)) continue;
      const ev = evaluateMission(m, snap, true);
      if (!ev) continue;
      m.evaluation = ev;
      applyLearning(this.state.learning, m, ev);
      const user = m.completedBy ?? "system";
      const p = this.player(user);
      const add = (xp: number, reason: string) => {
        const g = this.award(user, xp, xp, reason, m.id);
        m.xpAwarded += g.amount;
        m.pointsAwarded += g.points;
      };
      // rewards only for a confirmed result
      if (ev.preventedEmpty) add(X.preventedStockout, "Prevented stockout");
      if (ev.preventedWaste) add(X.reducedWaste, "Reduced waste");
      if (ev.result === "EXCELLENT") add(X.excellentResult, "Excellent result");
      // streak & counters follow real outcomes, never clicks
      if (ev.successRate >= 0.5) {
        p.streak += 1;
        p.bestStreak = Math.max(p.bestStreak, p.streak);
      } else p.streak = 0;
      ev.lines.forEach((l, i) => {
        const line = m.lines[i];
        if (l.categoryId === "hot" && l.salesInWindow > line.targetStockBefore) p.counters.hotStockoutsPrevented += 1;
        if (line.sourceWasteUnits >= 1) p.counters.wasteSaved += Math.min(l.soldAttributed, Math.round(line.sourceWasteUnits));
      });
      this.unlockAchievements(user);
    }
  }

  /** End of day: bonus for the team if ≥ 90% of taken missions were completed. */
  private dayBonus(day: number) {
    if (!GAMIFICATION) return;
    if (this.state.dayBonusDays.includes(day)) return;
    this.state.dayBonusDays.push(day);
    this.state.dayBonusDays = this.state.dayBonusDays.slice(-60);
    const X = ENGINE_CONFIG.xp;
    const taken = this.state.missions.filter((m) => dayNumber(m.createdAt) === day && m.acceptedAt !== null);
    const done = taken.filter((m) => m.status === "COMPLETED");
    if (done.length < X.dayCompletedMinMissions || done.length / Math.max(1, taken.length) < X.dayCompletedRate) return;
    for (const user of new Set(done.map((m) => m.completedBy).filter(Boolean) as string[]))
      this.award(user, X.dayCompleted, X.dayCompleted, "Day completed", null);
  }

  // ───────────────────────── mission workflow ─────────────────────────

  async missionAction(id: string, user: string, a: MissionAction): Promise<{ mission: Mission; xp: XpGain[]; impact?: CompletionImpact }> {
    const m = this.state.missions.find((x) => x.id === id);
    if (!m) throw new HttpError(404, "Задача не найдена");
    const snap = await this.snapshot();
    const now = snap.now;
    const xp: XpGain[] = [];
    const X = ENGINE_CONFIG.xp;
    let impact: CompletionImpact | undefined;

    switch (a.action) {
      case "accept":
        if (m.status !== "NEW") throw new HttpError(409, "Задачу уже взяли в работу");
        m.status = "ACCEPTED";
        m.acceptedAt = now;
        m.acceptedBy = user;
        break;
      case "start":
        if (m.status === "IN_PROGRESS") break;
        if (m.status !== "NEW" && m.status !== "ACCEPTED") throw new HttpError(409, "Задачу нельзя начать");
        if (!m.acceptedAt) {
          m.acceptedAt = now;
          m.acceptedBy = user;
        }
        m.status = "IN_PROGRESS";
        m.startedAt = now;
        break;
      case "complete": {
        if (m.status !== "ACCEPTED" && m.status !== "IN_PROGRESS" && m.status !== "NEW")
          throw new HttpError(409, "Задача уже закрыта");
        const result = this.analysisFor(snap, m.mode ?? "realtime");
        const fIdx = new Map(snap.fridges.map((f, i) => [f.id, i]));
        const pIdx = new Map(snap.products.map((p, i) => [p.id, i]));
        const s = fIdx.get(m.sourceFridgeId) ?? -1;
        let perfect = true;
        let savedSales = 0;
        let wasteReduced = 0;
        m.lines.forEach((line, li) => {
          const t = fIdx.get(line.targetFridgeId ?? m.targetFridgeId) ?? -1;
          const c = snap.categories.findIndex((x) => x.id === line.categoryId);
          // capture the state right before the transfer for the feedback loop
          if (t >= 0) {
            const tf = result.forecasts[t].categories[c];
            line.targetStockBefore = tf.stock;
            line.predictedTargetSales2h = Math.round(tf.expected2h * 10) / 10;
          }
          const catQty = a.quantities?.[line.categoryId];
          for (const p of line.products) {
            const item = a.items?.find((x) => x.lineIndex === li && x.productId === p.productId);
            let actual = p.qty;
            if (a.items) actual = item ? Math.max(0, Math.round(item.qty)) : 0; // mobile checklist: only what was chosen
            else if (catQty !== undefined && line.recommendedQty > 0) actual = Math.round((p.qty * catQty) / line.recommendedQty);
            const selected = item?.selectedQty ?? actual;
            // taking less than recommended is NORMAL; "perfect" = delivered exactly what was picked up
            if (actual !== selected) perfect = false;
            p.selectedQty = selected;
            p.actualQty = actual;
            p.skipReason = item?.skipReason?.slice(0, 40) ?? (actual === 0 ? "skipped" : null);
          }
          let moved = line.products.reduce((acc, p) => acc + (p.actualQty ?? 0), 0);
          if (this.mode === "mock" && this.sim && s >= 0 && t >= 0) {
            // Mock only: move the units inside the simulator. Real mode just records — KitShop is never written to.
            moved = this.sim.applyTransfer(
              s,
              t,
              line.products.map((p) => ({ productIndex: pIdx.get(p.productId) ?? 0, qty: p.actualQty ?? 0 })),
            );
          }
          line.actualQty = moved;
          savedSales += Math.min(moved, line.expectedShortage);
          wasteReduced += Math.min(moved, Math.round(line.sourceWasteUnits));
        });
        const recommendedTotal = m.lines.reduce((acc, l) => acc + l.recommendedQty, 0);
        const movedTotal = m.lines.reduce((acc, l) => acc + (l.actualQty ?? 0), 0);
        if (!m.acceptedAt) {
          m.acceptedAt = now;
          m.acceptedBy = user;
        }
        // acceptance learning: how much of the recommendation people really move (per source + network)
        m.acceptance = recommendedTotal > 0 ? movedTotal / recommendedTotal : null;
        if (m.acceptance !== null) {
          const K = ENGINE_CONFIG.conservative;
          const table = (this.state.learning.acceptance ??= {});
          for (const key of [m.sourceFridgeId, "_all"]) {
            const cur = table[key] ?? { ratio: 1, n: 0 };
            table[key] = { ratio: cur.n === 0 ? m.acceptance : cur.ratio * (1 - K.acceptanceRate) + m.acceptance * K.acceptanceRate, n: cur.n + 1 };
          }
        }
        if (movedTotal === 0) {
          // nothing moved → the route was skipped, not completed (no XP, no evaluation)
          m.status = "SKIPPED";
          m.skippedAt = now;
          m.skipReason = "ничего не перенесли";
          break;
        }
        for (const stop of m.stops) {
          const delivered = m.lines.some((l) => l.targetFridgeId === stop.targetFridgeId && (l.actualQty ?? 0) > 0);
          if (delivered) stop.deliveredAt = stop.deliveredAt ?? now;
        }
        m.status = "COMPLETED";
        m.completedAt = now;
        m.completedBy = user;
        this.startTransfer(snap, m, user);
        // XP for the work; OPS POINTS come later, only for the confirmed result
        xp.push(this.award(user, X.missionCompleted, 0, "Задача выполнена", m.id));
        if (m.type === "URGENT") xp.push(this.award(user, X.urgentBonus, 0, "Срочная задача", m.id));
        if (perfect) xp.push(this.award(user, X.perfectQuantity, 0, "Точное количество", m.id));
        const fullRoute = m.stops.length >= 2 && m.stops.every((st) => st.deliveredAt !== null);
        if (fullRoute) xp.push(this.award(user, X.fullRoute, 0, "Маршрут пройден полностью", m.id));
        const p = this.player(user);
        p.counters.perfectRoutesInRow = perfect ? p.counters.perfectRoutesInRow + 1 : 0;
        if (m.type === "URGENT" && now - m.createdAt <= X.fastResponseMinutes * MINUTE_MS) p.counters.fastUrgent += 1;
        m.xpAwarded += xp.reduce((acc, g) => acc + g.amount, 0);
        impact = {
          savedSales,
          wasteReduced,
          unlockedRewards: this.checkRewards(user),
          unlockedAchievements: this.unlockAchievements(user),
        };
        break;
      }
      case "skip":
        if (m.status === "COMPLETED" || m.status === "SKIPPED") throw new HttpError(409, "Задача уже закрыта");
        m.status = "SKIPPED";
        m.skippedAt = now;
        m.skipReason = a.reason?.slice(0, 200) || null;
        break;
    }
    this.save();
    return { mission: m, xp, impact };
  }

  // ───────────────────────── KiT Shop operations ─────────────────────────

  /**
   * KiT Shop product catalog as we know it.
   * MOCK: a fake catalog built from the simulator's products (a few are deliberately missing, to exercise
   * MAPPING_REQUIRED / "Создать в KiT Shop"), plus products created through the mock adapter.
   * KITSHOP: filled by the catalog sync (GetProducts) — not connected yet → empty → every line needs mapping.
   */
  catalog(snap: NetworkSnapshot): CatalogItem[] {
    if (this.mode !== "mock") return [];
    const items: CatalogItem[] = snap.products
      .map((p, i) => ({ p, i }))
      .filter(({ i }) => i % 17 !== 16)
      .map(({ p, i }) => ({ productId: String(810_000 + i), name: p.name, barcode: p.barcode, vendorCode: p.sku }));
    for (const [pid, m] of Object.entries(this.state.productMappings)) {
      if (m.matchedBy !== "manual" || items.some((c) => c.productId === m.kitshopProductId)) continue;
      const p = snap.products.find((x) => x.id === pid);
      if (p) items.push({ productId: m.kitshopProductId, name: p.name, barcode: p.barcode, vendorCode: p.sku });
    }
    return items;
  }

  mappingFor(snap: NetworkSnapshot, productId: string, catalog = this.catalog(snap)): MappingResult {
    const p = snap.products.find((x) => x.id === productId);
    if (!p) return { status: "MAPPING_REQUIRED", reason: "not_found", suggestions: [] };
    return resolveMapping({ id: p.id, name: p.name, barcode: p.barcode, sku: p.sku }, catalog, this.state.productMappings[p.id]);
  }

  /** Our items → operation lines with the stable KiT Shop ProductId ('' = not mapped → MAPPING_REQUIRED). */
  opLines(snap: NetworkSnapshot, items: { productId: string; qty: number }[]): OpLine[] {
    const catalog = this.catalog(snap);
    return items.map((it) => {
      const p = snap.products.find((x) => x.id === it.productId);
      const m = this.mappingFor(snap, it.productId, catalog);
      return { productId: it.productId, kitshopProductId: m.status === "MAPPED" ? m.kitshopProductId : "", name: p?.name ?? it.productId, qty: it.qty };
    });
  }

  async submitOperation(
    input: { id: string; type: OpType; fridgeId: string; items: { productId: string; qty: number }[]; reason?: string },
    user: string,
  ): Promise<{ op: KsOperation; duplicate: boolean }> {
    this.assertWritable("Загрузка / снятие / списание");
    const existing = this.ops.get(input.id);
    if (existing) {
      // idempotent replay (double tap, offline re-send): nothing is sent again
      this.ops.audit(user, "op.duplicate_submit", "operation", existing.id, { status: existing.status });
      return { op: existing, duplicate: true };
    }
    const snap = await this.snapshot();
    const fridge = snap.fridges.find((f) => f.id === input.fridgeId);
    if (!fridge) throw new HttpError(404, "Холодильник не найден");
    return this.ops.submit(
      {
        id: input.id,
        type: input.type,
        fridgeId: fridge.id,
        shopId: /^\d+$/.test(fridge.externalId) ? fridge.externalId : "",
        fridgeName: fridge.name,
        lines: this.opLines(snap, input.items),
        reason: input.reason ?? null,
        applyToSim: this.mode === "mock",
      },
      user,
    );
  }

  /** Mission completed → TRANSFER = source UNLOAD + target LOAD(s) with the ACTUAL quantities. Runs in background. */
  private startTransfer(snap: NetworkSnapshot, m: Mission, user: string) {
    // read-only: the recommendation is recorded only in our system, nothing goes to KiT Shop
    if (this.readOnly) return;
    const fr = new Map(snap.fridges.map((f) => [f.id, f]));
    const src = fr.get(m.sourceFridgeId);
    if (!src) return;
    const byTarget = new Map<string, { productId: string; qty: number }[]>();
    for (const line of m.lines) {
      const t = line.targetFridgeId ?? m.targetFridgeId;
      for (const p of line.products) if ((p.actualQty ?? 0) > 0) (byTarget.get(t) ?? byTarget.set(t, []).get(t)!).push({ productId: p.productId, qty: p.actualQty ?? 0 });
    }
    const shopOf = (id: string) => (/^\d+$/.test(id) ? id : "");
    const targets = [...byTarget.entries()].flatMap(([id, items]) => {
      const f = fr.get(id);
      return f ? [{ fridgeId: f.id, shopId: shopOf(f.externalId), fridgeName: f.name, lines: this.opLines(snap, items) }] : [];
    });
    if (!targets.length) return;
    this.ops
      // MOCK: the mission already moved the units inside the simulator — the legs must not move them again
      .transfer({ missionId: m.id, source: { fridgeId: src.id, shopId: shopOf(src.externalId), fridgeName: src.name }, targets, applyToSim: false }, user)
      .catch((e) => {
        console.warn(`[kitshop-ops] transfer for mission #${m.number} not started:`, e instanceof Error ? e.message : e);
        this.ops.audit(user, "transfer.not_started", "mission", m.id, { error: e instanceof Error ? e.message : String(e) });
        this.save();
      });
  }

  // ── product mapping (admin) ──

  /** ADMIN links our product to a KiT Shop ProductId (e.g. after choosing a name suggestion). */
  async confirmMapping(productId: string, kitshopProductId: string, admin: string) {
    const snap = await this.snapshot();
    if (!snap.products.some((p) => p.id === productId)) throw new HttpError(404, "Товар не найден");
    const catalog = this.catalog(snap);
    if (this.mode === "mock" && !catalog.some((c) => c.productId === kitshopProductId)) throw new HttpError(422, "Такого товара нет в каталоге KiT Shop");
    const taken = Object.entries(this.state.productMappings).find(([pid, m]) => pid !== productId && m.kitshopProductId === kitshopProductId && !m.inactive);
    if (taken) throw new HttpError(409, "Этот товар KiT Shop уже привязан к другому блюду");
    const prev = this.state.productMappings[productId];
    this.state.productMappings[productId] = { kitshopProductId, matchedBy: "manual", confirmedBy: admin, at: Date.now(), inactive: prev?.inactive };
    this.ops.audit(admin, "mapping.confirm", "product", productId, { kitshopProductId, previous: prev?.kitshopProductId ?? null });
    this.save();
    return { ok: true };
  }

  /** "Деактивировать локально": hide in Apps Холодосов. KiT Shop is never asked to delete anything. */
  async setProductInactive(productId: string, inactive: boolean, admin: string) {
    const snap = await this.snapshot();
    const cur = this.state.productMappings[productId];
    const m = this.mappingFor(snap, productId);
    this.state.productMappings[productId] = cur
      ? { ...cur, inactive }
      : { kitshopProductId: m.status === "MAPPED" ? m.kitshopProductId : "", matchedBy: m.status === "MAPPED" ? m.matchedBy : "manual", confirmedBy: admin, at: Date.now(), inactive };
    this.ops.audit(admin, inactive ? "product.deactivate_local" : "product.activate_local", "product", productId, {});
    this.save();
    return { ok: true };
  }

  /** ADMIN only. preview → exactly what AddProduct would receive. Create → only through the gated adapter. */
  async createInKitShop(productId: string, preview: boolean, admin: string) {
    this.assertWritable("Создание товара");
    const snap = await this.snapshot();
    const p = snap.products.find((x) => x.id === productId);
    if (!p) throw new HttpError(404, "Товар не найден");
    const m = this.mappingFor(snap, productId);
    if (m.status === "MAPPED") throw new HttpError(409, "Товар уже есть в KiT Shop");
    if (m.reason === "ambiguous") throw new HttpError(409, "В KiT Shop несколько товаров с этим штрихкодом — сначала разберитесь с дублями");
    if (this.state.kitshopAdmin?.writesPaused) throw new HttpError(423, "Запись в KiT Shop приостановлена (PAUSE ALL WRITES)");
    const input: CatalogProductInput = { name: p.name, barcode: p.barcode, vendorCode: p.sku, price: p.price || null, unitType: 1, taxType: 0, accuracyType: 1 };
    const adapter = catalogAdapter();
    const body = addProductBody(input);
    if (preview) {
      return {
        preview: true,
        mode: adapter.mode,
        method: "AddProduct",
        body,
        notes: [
          "UnitType 1 = штучное, TaxType 0 = не выставлен, AccuracyType 1 = абсолютная — проверьте перед созданием.",
          m.suggestions.length ? `Похожие товары уже есть в KiT Shop: ${m.suggestions.map((s) => s.name).join(", ")}. Возможно, нужна привязка, а не новый товар.` : null,
        ].filter(Boolean),
      };
    }
    this.ops.audit(admin, "product.create_request", "product", productId, { mode: adapter.mode, body });
    const res = await adapter.addProduct(input);
    this.ops.audit(admin, "product.create_result", "product", productId, { mode: adapter.mode, outcome: res.kind, productId: res.productId ?? null });
    if (res.kind === "ok" && res.productId) {
      this.state.productMappings[productId] = { kitshopProductId: res.productId, matchedBy: "manual", confirmedBy: admin, at: Date.now() };
    }
    this.save();
    if (res.kind === "ok") return { preview: false, mode: adapter.mode, created: !!res.productId, kitshopProductId: res.productId ?? null, message: res.message ?? "Создано" };
    if (res.kind === "rejected") throw new HttpError(502, `KiT Shop отказал: ${res.message} (код ${res.code})`);
    // AddProduct is not idempotent: never retry blindly — search the catalog by barcode first
    throw new HttpError(504, "Нет ответа от KiT Shop. Не повторяйте: сначала проверьте каталог по штрихкоду (товар мог создаться).");
  }

  /** MOCK only: a confirmed standalone load/unload/write-off changes the simulator's stock. */
  private applyConfirmedToSim(op: KsOperation) {
    if (!op.applyToSim || this.mode !== "mock" || !this.sim) return;
    const fi = this.sim.model.fridges.findIndex((f) => f.id === op.fridgeId);
    if (fi < 0) return;
    for (const l of op.lines) {
      const pi = this.sim.model.products.findIndex((p) => p.id === l.productId);
      if (pi >= 0) this.sim.adjustStock(fi, pi, op.type === "LOAD" ? l.qty : -l.qty);
    }
    this.cache.clear();
  }

  // ───────────────────────── admin ─────────────────────────

  updateFridgeSettings(id: string, patch: FridgeSettings) {
    const cur = this.state.fridgeSettings[id] ?? {};
    this.state.fridgeSettings[id] = { ...cur, ...patch };
    this.state.settingsVersion += 1;
    this.cache.clear();
    this.save();
    return this.state.fridgeSettings[id];
  }

  setTravelOverride(a: string, b: string, minutes: number | null) {
    const key = [a, b].sort().join(">");
    if (minutes === null) delete this.state.travelOverrides[key];
    else this.state.travelOverrides[key] = minutes;
    this.state.settingsVersion += 1;
    this.cache.clear();
    this.save();
  }

  // ───────────────────────── simulator controls ─────────────────────────

  requireSim(): Simulator {
    if (!this.sim) throw new HttpError(400, "Доступно только в MOCK-режиме");
    return this.sim;
  }

  /**
   * Advances the simulated clock in 15-min steps: evaluates missions and (by default) runs the hourly analysis on the hour.
   * hourlyAnalysis=false is used by the real-time catch-up, which analyses once at the end.
   */
  advance(minutes: number, hourlyAnalysis = true): { missionsCreated: number } {
    const sim = this.requireSim();
    let created = 0;
    let left = minutes;
    while (left > 0) {
      sim.advance(15, () => {
        // end of day: evaluate what we can, expire what nobody did, team day bonus
        const snap = this.simSnapshot();
        this.evaluateDue(snap, true);
        for (const m of this.state.missions)
          if (m.status === "NEW" || m.status === "ACCEPTED" || m.status === "IN_PROGRESS") m.status = "EXPIRED";
        this.dayBonus(snap.today.day);
      });
      left -= 15;
      const onTheHour = sim.state.minute % ENGINE_CONFIG.analysisIntervalMinutes === 0;
      if (!hourlyAnalysis && !onTheHour) continue;
      const snap = this.simSnapshot();
      this.evaluateDue(snap);
      if (hourlyAnalysis && onTheHour) created += this.createMissions(snap).length;
    }
    this.save();
    return { missionsCreated: created };
  }

  devAction(action: string): string {
    const sim = this.requireSim();
    let text = "";
    switch (action) {
      case "advance15":
        this.advance(15);
        return "+15 минут";
      case "advance60":
        this.advance(60);
        return "+1 час";
      case "advance180":
        this.advance(180);
        return "+3 часа";
      case "sales":
        text = sim.simulateSales();
        break;
      case "shortage":
        text = sim.createShortage();
        break;
      case "overstock":
        text = sim.createOverstock();
        break;
      case "anomaly":
        text = sim.createAnomaly();
        break;
      case "to-close": {
        // jump to the clock time of the "ДО HH:MM" mode (Настройки) — fridges themselves may keep selling later
        const snap = this.simSnapshot();
        const until = this.untilMinute();
        const left = until - minuteOfDay(snap.now);
        if (left <= 0) return `Уже позже ${fmtHM(until)}`;
        this.advance(Math.ceil(left / 15) * 15);
        return `Прокручено до ${fmtHM(until)}`;
      }
      case "now": {
        // back to the real current time (after "+1 час" / "до HH:MM")
        const target = wallClockNow(TZ);
        const start = minuteOfDay(target) - (minuteOfDay(target) % 15);
        if (dayNumber(target) !== sim.state.day || sim.now > target) {
          for (const m of this.state.missions) if (m.status === "NEW" || m.status === "ACCEPTED" || m.status === "IN_PROGRESS") m.status = "EXPIRED";
          if (dayNumber(target) === sim.state.day) sim.resetDay(start);
          else {
            this.sim = Simulator.create(sim.state.seed, dayNumber(target), start);
            this.state.sim = this.sim.state;
          }
          this.cache.clear();
        }
        this.runHourlySync();
        this.save();
        return `Реальное время · ${fmtHM(minuteOfDay(target))}`;
      }
      case "reset-day":
        for (const m of this.state.missions) if (dayNumber(m.createdAt) === sim.state.day) m.status = "EXPIRED";
        text = sim.resetDay();
        break;
      case "ks-timeout":
      case "ks-lost":
      case "ks-reject":
      case "ks-offline":
      case "ks-slow": {
        // fake KiT Shop only: the next operation answers with this scenario
        const sc = ({ "ks-timeout": "timeout", "ks-lost": "lost", "ks-reject": "reject", "ks-offline": "unreachable", "ks-slow": "slow" } as const)[action];
        mockAdapter().script.push(sc);
        return `Тренировочный KiT Shop: следующая операция → ${sc}`;
      }
      case "analyze":
        this.runHourlySync();
        this.save();
        return "Анализ выполнен";
      case "reseed": {
        const seed = Math.floor(Math.random() * 1e6);
        this.state = {
          ...emptyState(),
          users: this.state.users,
          sessions: this.state.sessions,
          devices: this.state.devices,
          players: this.state.players,
          rewardClaims: this.state.rewardClaims,
          operations: this.state.operations,
          audit: this.state.audit,
          productMappings: this.state.productMappings,
          kitshopAdmin: this.state.kitshopAdmin,
          fridgeSettings: this.state.fridgeSettings,
          travelOverrides: this.state.travelOverrides,
          settingsVersion: this.state.settingsVersion + 1,
        };
        this.sim = Simulator.create(seed, dayNumber(wallClockNow(TZ)));
        this.state.sim = this.sim.state;
        this.cache.clear();
        this.runHourlySync();
        this.save();
        return `Новый мир (seed ${seed})`;
      }
      default:
        throw new HttpError(400, "Неизвестное действие");
    }
    this.runHourlySync();
    this.save();
    return text;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const g = globalThis as unknown as { __fridgeOpsRuntime?: Promise<Runtime> };

/** One runtime per server process, initialised from the store on first use. */
export function getRuntime(): Promise<Runtime> {
  if (!g.__fridgeOpsRuntime) {
    g.__fridgeOpsRuntime = Runtime.create().catch((e) => {
      console.error("[apps-holodosov] startup failed:", e instanceof Error ? e.message : e);
      g.__fridgeOpsRuntime = undefined;
      throw e;
    });
  }
  return g.__fridgeOpsRuntime;
}

export type { Runtime };
