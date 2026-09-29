import "server-only";
import { ENGINE_CONFIG } from "../config/engine";
import type { Mission, NetworkSnapshot } from "../domain/types";
import { analyze, type AnalysisResult } from "../engine/analysis";
import { buildTravelMatrix } from "../engine/distance";
import { applyLearning, evaluateMission, isDue } from "../engine/feedback";
import { createStore, emptyState, newPlayer, type AppState, type FridgeSettings, type Player, type StateStore } from "../store/appStore";
import { deliver, detectAlerts } from "./notifications";
import { bootstrapUsers } from "./users";
import { Simulator } from "../simulator/simulator";
import { dayNumber, minuteOfDay, MINUTE_MS, wallClockNow } from "../time";
import { KitShopDataSource } from "@/services/kitshop";

/**
 * Server runtime: owns the data source (simulator in MOCK mode), our app state,
 * the analysis cache, the mission/route workflow and gamification. One instance per server process.
 */

export interface CompleteItem {
  lineIndex: number;
  productId: string;
  qty: number;
  /** "Есть только N" — the fridge physically had less; not the employee's fault. */
  unavailable?: boolean;
}

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

const TZ = process.env.APP_TIMEZONE || "Europe/Moscow";

class Runtime {
  state: AppState;
  sim: Simulator | null = null;
  readonly mode: "mock" | "kitshop";
  readonly store: StateStore;
  private cache: { key: string; result: AnalysisResult } | null = null;
  private kitshop = new KitShopDataSource();
  private saving: Promise<void> | null = null;
  private dirty = false;
  private catchingUp = false;

  private constructor(state: AppState, store: StateStore) {
    this.mode = process.env.DATA_SOURCE === "kitshop" ? "kitshop" : "mock";
    this.state = state;
    this.store = store;
  }

  /** Loads OUR state from the configured store (PostgreSQL in production) and prepares the runtime. */
  static async create(): Promise<Runtime> {
    const store = await createStore();
    console.info(`[fridge-ops] starting · store=${store.kind} · data=${process.env.DATA_SOURCE ?? "mock"}`);
    const rt = new Runtime(await store.load(), store);
    console.info(`[fridge-ops] state loaded · users=${rt.state.users.length} · missions=${rt.state.missions.length}`);
    try {
      const created = bootstrapUsers(rt.state);
      if (created.length) console.info(`[fridge-ops] created initial accounts: ${created.join(", ")}`);
    } catch (e) {
      // a bad ADMIN_LOGIN / ADMIN_PIN must not take the whole service down
      console.error("[fridge-ops] could not create the first administrator:", e instanceof Error ? e.message : e, "— check ADMIN_LOGIN (2–32 chars) and ADMIN_PIN (4–8 digits)");
    }
    if (rt.mode === "mock") rt.ensureSim();
    rt.save();
    await rt.saving;
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
        console.error("[fridge-ops] failed to persist state", e);
      }
    }
    this.saving = null;
  }

  async flushNow() {
    this.save();
    await this.saving;
  }

  /**
   * SIM_REALTIME=true (pilot / demo server): the simulated clock follows the real clock,
   * so a deployed mock server behaves like a live network without anyone pressing DEV buttons.
   */
  private catchUpRealtime() {
    if (process.env.SIM_REALTIME !== "true" || !this.sim || this.catchingUp) return;
    const target = wallClockNow(TZ);
    const behind = Math.floor((target - this.sim.now) / MINUTE_MS);
    if (behind < 15) return;
    this.catchingUp = true;
    try {
      if (behind > 36 * 60) {
        this.sim = Simulator.create(this.sim.state.seed, dayNumber(target), minuteOfDay(target) - (minuteOfDay(target) % 15));
        this.state.sim = this.sim.state;
        this.cache = null;
        this.runHourlySync();
        this.save();
      } else {
        this.advance(behind - (behind % 15));
      }
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
    return this.withSettings(await this.kitshop.snapshot());
  }

  private simSnapshot(): NetworkSnapshot {
    return this.withSettings(this.requireSim().snapshot());
  }

  private activeMissions(): Mission[] {
    return this.state.missions.filter((m) => m.status === "ACCEPTED" || m.status === "IN_PROGRESS");
  }

  private analysisFor(snap: NetworkSnapshot): AnalysisResult {
    const active = this.activeMissions();
    const key = `${snap.version}|${JSON.stringify(this.state.learning).length}|${active.map((m) => m.id + m.status).join(",")}`;
    if (this.cache?.key === key) return this.cache.result;
    const result = analyze(snap, this.state.learning, active);
    this.cache = { key, result };
    return result;
  }

  async analysis(): Promise<{ snap: NetworkSnapshot; result: AnalysisResult }> {
    const snap = await this.snapshot();
    return { snap, result: this.analysisFor(snap) };
  }

  /** Current display names (Admin can rename fridges at any time). */
  names(snap: NetworkSnapshot): Record<string, string> {
    return Object.fromEntries(snap.fridges.map((f) => [f.id, f.name]));
  }

  // ───────────────────────── hourly analysis → missions ─────────────────────────

  private runHourlySync(): Mission[] {
    if (!this.sim) return [];
    const snap = this.simSnapshot();
    return this.createMissions(snap, this.analysisFor(snap));
  }

  async runHourly(): Promise<Mission[]> {
    const { snap, result } = await this.analysis();
    const created = this.createMissions(snap, result);
    this.save();
    return created;
  }

  /** Replaces untouched NEW missions with the fresh top list. */
  private createMissions(snap: NetworkSnapshot, result: AnalysisResult): Mission[] {
    for (const m of this.state.missions) if (m.status === "NEW") m.status = "EXPIRED";
    const created: Mission[] = result.drafts.map((d) => {
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
        xpAwarded: 0,
        pointsAwarded: 0,
      };
    });
    this.state.missions.push(...created);
    this.state.lastAnalysisAt = snap.now;
    // important alerts only (future push notifications)
    for (const n of detectAlerts(snap, result, this.state, created)) {
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
      this.createMissions(snap, this.analysisFor(snap));
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
    const p = this.player(user);
    p.xp += amount;
    p.points += points;
    this.state.xpEvents.push({ at: this.now(), user, amount, points, reason, missionId });
    this.checkRewards(user);
    return { amount, points, reason };
  }

  /** Unlocks reward milestones by lifetime points. Never hands out anything by itself. */
  private checkRewards(user: string): string[] {
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
        const result = this.analysisFor(snap);
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
            if (item) actual = Math.max(0, Math.round(item.qty));
            else if (catQty !== undefined && line.recommendedQty > 0) actual = Math.round((p.qty * catQty) / line.recommendedQty);
            if (actual !== p.qty && !item?.unavailable) perfect = false;
            p.actualQty = actual;
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
        for (const stop of m.stops) stop.deliveredAt = stop.deliveredAt ?? now;
        if (!m.acceptedAt) {
          m.acceptedAt = now;
          m.acceptedBy = user;
        }
        m.status = "COMPLETED";
        m.completedAt = now;
        m.completedBy = user;
        // XP for the work; OPS POINTS come later, only for the confirmed result
        xp.push(this.award(user, X.missionCompleted, 0, "Задача выполнена", m.id));
        if (m.type === "URGENT") xp.push(this.award(user, X.urgentBonus, 0, "Срочная задача", m.id));
        if (perfect) xp.push(this.award(user, X.perfectQuantity, 0, "Точное количество", m.id));
        const fullRoute = m.stops.length >= 2 && m.lines.every((l) => (l.actualQty ?? 0) > 0);
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

  // ───────────────────────── admin ─────────────────────────

  updateFridgeSettings(id: string, patch: FridgeSettings) {
    const cur = this.state.fridgeSettings[id] ?? {};
    this.state.fridgeSettings[id] = { ...cur, ...patch };
    this.state.settingsVersion += 1;
    this.cache = null;
    this.save();
    return this.state.fridgeSettings[id];
  }

  setTravelOverride(a: string, b: string, minutes: number | null) {
    const key = [a, b].sort().join(">");
    if (minutes === null) delete this.state.travelOverrides[key];
    else this.state.travelOverrides[key] = minutes;
    this.state.settingsVersion += 1;
    this.cache = null;
    this.save();
  }

  // ───────────────────────── simulator controls ─────────────────────────

  requireSim(): Simulator {
    if (!this.sim) throw new HttpError(400, "Доступно только в MOCK-режиме");
    return this.sim;
  }

  /** Advances the simulated clock in 15-min steps: evaluates missions and runs the hourly analysis on the hour. */
  advance(minutes: number): { missionsCreated: number } {
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
      const snap = this.simSnapshot();
      this.evaluateDue(snap);
      if (minuteOfDay(snap.now) % ENGINE_CONFIG.analysisIntervalMinutes === 0) {
        created += this.createMissions(snap, this.analysisFor(snap)).length;
      }
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
      case "reset-day":
        for (const m of this.state.missions) if (dayNumber(m.createdAt) === sim.state.day) m.status = "EXPIRED";
        text = sim.resetDay();
        break;
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
          fridgeSettings: this.state.fridgeSettings,
          travelOverrides: this.state.travelOverrides,
          settingsVersion: this.state.settingsVersion + 1,
        };
        this.sim = Simulator.create(seed, dayNumber(wallClockNow(TZ)));
        this.state.sim = this.sim.state;
        this.cache = null;
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
      console.error("[fridge-ops] startup failed:", e instanceof Error ? e.message : e);
      g.__fridgeOpsRuntime = undefined;
      throw e;
    });
  }
  return g.__fridgeOpsRuntime;
}

export type { Runtime };
