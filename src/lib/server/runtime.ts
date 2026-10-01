import "server-only";
import { ENGINE_CONFIG } from "../config/engine";
import type { ForecastMode, Mission, NetworkSnapshot } from "../domain/types";
import { analyze, type AnalysisResult } from "../engine/analysis";
import { buildTravelMatrix } from "../engine/distance";
import { applyLearning, evaluateMission, isDue } from "../engine/feedback";
import { createStore, emptyState, newPlayer, type AppState, type FridgeSettings, type Player, type StateStore } from "../store/appStore";
import { deliver, detectAlerts } from "./notifications";
import { bootstrapUsers } from "./users";
import { Simulator } from "../simulator/simulator";
import { dayNumber, fmtHM, minuteOfDay, MINUTE_MS, wallClockNow, weekdayOf } from "../time";
import { KitShopDataSource } from "@/services/kitshop";

/**
 * Server runtime: owns the data source (simulator in MOCK mode), our app state,
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

export const FORECAST_MODES: ForecastMode[] = ["realtime", "until20"];

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

class Runtime {
  state: AppState;
  sim: Simulator | null = null;
  readonly mode: "mock" | "kitshop";
  readonly store: StateStore;
  private cache = new Map<ForecastMode, { key: string; result: AnalysisResult }>();
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
    return this.withSettings(await this.kitshop.snapshot());
  }

  private simSnapshot(): NetworkSnapshot {
    return this.withSettings(this.requireSim().snapshot());
  }

  private activeMissions(): Mission[] {
    return this.state.missions.filter((m) => m.status === "ACCEPTED" || m.status === "IN_PROGRESS");
  }

  /** The selected forecast horizon really changes the engine (REAL TIME vs ДО 20:00). */
  private analysisFor(snap: NetworkSnapshot, mode: ForecastMode = "realtime"): AnalysisResult {
    const active = this.activeMissions();
    const key = `${snap.version}|${JSON.stringify(this.state.learning).length}|${active.map((m) => m.id + m.status).join(",")}`;
    const hit = this.cache.get(mode);
    if (hit?.key === key) return hit.result;
    const result = analyze(snap, this.state.learning, active, mode);
    this.cache.set(mode, { key, result });
    return result;
  }

  async analysis(mode: ForecastMode = "realtime"): Promise<{ snap: NetworkSnapshot; result: AnalysisResult }> {
    const snap = await this.snapshot();
    return { snap, result: this.analysisFor(snap, mode) };
  }

  /** Most common closing time of fridges working today (from Настройки) — label of the second mode. */
  closeTime(snap: NetworkSnapshot): string {
    const counts = new Map<number, number>();
    for (const f of snap.fridges) {
      if (!f.isActive || !f.workingDays.includes(weekdayOf(dayNumber(snap.now)))) continue;
      counts.set(f.closingMinute, (counts.get(f.closingMinute) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 20 * 60;
    return fmtHM(best);
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
    const drafts = FORECAST_MODES.flatMap((mode) => this.analysisFor(snap, mode).drafts);
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
        // jump to the end of the working day: the latest closing time among today's fridges
        const snap = this.simSnapshot();
        const today = weekdayOf(dayNumber(snap.now));
        const close = Math.max(0, ...snap.fridges.filter((f) => f.workingDays.includes(today)).map((f) => f.closingMinute));
        const left = close - minuteOfDay(snap.now);
        if (left <= 0) return `Уже после закрытия (${fmtHM(close)})`;
        this.advance(Math.ceil(left / 15) * 15);
        return `Прокручено до закрытия · ${fmtHM(close)}`;
      }
      case "now": {
        // back to the real current time (after "+1 час" / "до закрытия")
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
      console.error("[fridge-ops] startup failed:", e instanceof Error ? e.message : e);
      g.__fridgeOpsRuntime = undefined;
      throw e;
    });
  }
  return g.__fridgeOpsRuntime;
}

export type { Runtime };
