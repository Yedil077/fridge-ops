import "server-only";
import { randomUUID } from "node:crypto";
import { summarize, WriteTest, type KitShopAdminState } from "../kitshop-ops/writeTest";
import { OPEN_STATUSES } from "../kitshop-ops/types";
import { adapterFor, kitshopReader, kitshopServerInfo, kitshopTransport } from "./kitshopWrite";
import { HttpError, type Runtime } from "./runtime";
import { REAL_API_HOST, runRealDiagnostic } from "@/services/kitshop/realDiagnostic";
export type { RealDiagnosticReport, StepResult as RealStep, StepStatus } from "@/services/kitshop/realDiagnostic";
import { wallClockNow } from "../time";
import { ARCHETYPES } from "../simulator/archetypes";

/** Our fridges' KiT Shop ids & names — from the live snapshot, or the static list when the data source is down. */
export async function ourFridges(rt: Runtime): Promise<{ id: string; name: string; shopId: string | null }[]> {
  const snap = await rt.snapshot().catch(() => null);
  if (snap) return snap.fridges.map((f) => ({ id: f.id, name: f.name, shopId: /^\d+$/.test(f.externalId) ? f.externalId : null }));
  return ARCHETYPES.map((a) => ({ id: `F${a.code}`, name: a.name ?? a.code, shopId: a.kitshopId ?? null }));
}

/**
 * /admin/kitshop/diagnostics — Phase D tooling. Everything here is READ-ONLY towards KiT Shop,
 * except WriteTest.confirm(), which sends exactly one prepared ±1 operation after an explicit admin click.
 * Never returns passwords, Sign values or full request bodies with Auth.
 */

export function adminState(rt: Runtime): KitShopAdminState {
  rt.state.kitshopAdmin ??= { writesPaused: false, pausedBy: null, pausedAt: null, testShop: null, testProduct: null, writeTest: null };
  return rt.state.kitshopAdmin;
}

const mask = (v: string) => (v.length <= 4 ? "•".repeat(v.length) : `${v.slice(0, 2)}${"•".repeat(v.length - 4)}${v.slice(-2)}`);

/** Why the wizard may NOT write live to this shop (null = allowed). */
export function liveBlocked(shopId: string): string | null {
  const s = kitshopServerInfo();
  if (!s.config.enabled) return "KITSHOP_ENABLED не равен true";
  if (!s.config.companyId || !s.config.login || !s.config.password) return "не заданы KITSHOP_COMPANY_ID / KITSHOP_LOGIN / KITSHOP_PASSWORD";
  if (!s.gate.writeEnabled) return "KITSHOP_WRITE_ENABLED не равен true";
  if (s.gate.dryRun) return "включён KITSHOP_WRITE_DRY_RUN";
  if (!s.gate.shops.includes(shopId)) return `ShopId ${shopId} не указан в KITSHOP_WRITE_SHOPS`;
  if (s.gate.shops.length > 1) return "в KITSHOP_WRITE_SHOPS больше одной точки — для теста оставьте только тестовую";
  if (adapterFor(shopId, "write-test").mode !== "live") return "адаптер записи не live";
  return null;
}

export function writeTest(rt: Runtime): WriteTest {
  const st = adminState(rt);
  return new WriteTest({
    state: st,
    now: () => Date.now(),
    newId: () => randomUUID(),
    checkAuth: async () => {
      const t0 = Date.now();
      try {
        await kitshopReader().getAuthCheck();
        return { ok: true, ms: Date.now() - t0, detail: "CheckAuth: ResultCode 0" };
      } catch (e) {
        return { ok: false, ms: Date.now() - t0, detail: e instanceof Error ? e.message : "ошибка" };
      }
    },
    readStock: async (shopId, productId) => {
      const stocks = await kitshopReader().getShopStocks(shopId);
      return stocks.find((x) => x.ProductId === productId)?.Quantity ?? 0;
    },
    liveBlocked,
    isPaused: () => st.writesPaused,
    submit: (input, user) => rt.ops.submit(input, user),
    verify: (id, user) => rt.ops.verify(id, user),
    getOp: (id) => rt.ops.get(id),
    findInFillUps: (op) => adapterFor(op.shopId, "write-test").verifyFillUp({ id: op.id, shopId: op.shopId, sentAt: op.sentAt ?? op.createdAt }),
    auditFor: (id) => rt.state.audit.filter((a) => a.entityId === id),
    save: () => rt.save(),
  });
}

/**
 * Which KiT Shop this page talks to. REAL only when the configured host is api.kitshop.ru and reads are allowed
 * (KITSHOP_ENABLED or KITSHOP_REAL_DIAGNOSTICS). Anything else — including a local fake — is MOCK.
 */
export function kitshopTarget() {
  const s = kitshopServerInfo();
  let host = "";
  try {
    host = new URL(s.config.baseUrl).hostname;
  } catch {
    /* invalid URL → not real */
  }
  const realDiagnostics = process.env.KITSHOP_REAL_DIAGNOSTICS === "true";
  const real = host === REAL_API_HOST && (s.config.enabled || realDiagnostics);
  return { label: real ? "REAL KITSHOP" : "MOCK KITSHOP", real, host: host || "(не задан)", realDiagnostics, readEnabled: s.config.enabled };
}

/** REAL API TEST — read-only connectivity diagnostic through the app's own transport. Never mock, never a write. */
export async function runRealApiTest(rt: Runtime, user: string) {
  const s = kitshopServerInfo();
  const target = kitshopTarget();
  if (!target.realDiagnostics && !s.config.enabled)
    throw new HttpError(409, "Реальная диагностика выключена: задайте KITSHOP_REAL_DIAGNOSTICS=true (только чтение) в настройках сервера");
  const fridges = await ourFridges(rt);
  const st = adminState(rt);
  const report = await runRealDiagnostic({
    config: s.config,
    transport: kitshopTransport(), // one RequestId sequence with the rest of the app
    knownShopIds: fridges.map((f) => f.shopId).filter((id): id is string => !!id),
    testShopId: process.env.KITSHOP_TEST_SHOP_ID || st.testShop?.shopId || undefined,
    now: () => wallClockNow(process.env.APP_TIMEZONE || "Asia/Almaty"),
  });
  st.realDiagnostic = report;
  rt.ops.audit(user, "kitshop.real_diagnostic", "kitshop", "diagnostic", { summary: report.summary, failingStep: report.failingStep, category: report.failingCategory });
  rt.save();
  return report;
}

export async function diagnostics(rt: Runtime) {
  const s = kitshopServerInfo();
  const st = adminState(rt);
  const ops = rt.state.operations;
  const writeMode = !s.gate.writeEnabled ? "DISABLED" : s.liveOpen ? "LIMITED PRODUCTION" : "DRY RUN";
  const fridges = await ourFridges(rt);
  const call = (m: string) => s.calls.get(m) ?? null;
  const real = st.realDiagnostic ?? null;
  return {
    target: kitshopTarget(),
    // no generic "CONNECTED": only the result of the last REAL API TEST, step by step
    connection: !real ? "REAL API TEST не запускался" : real.failingStep ? `FAIL: ${real.failingStep}${real.failingCategory ? ` [${real.failingCategory}]` : ""}` : "REAL API TEST: PASS",
    realTest: real,
    readEnabled: s.config.enabled,
    companyId: s.config.companyId ? mask(s.config.companyId) : null,
    apiUser: s.config.login && s.config.password ? "configured" : "missing",
    baseUrl: s.config.baseUrl,
    signCase: kitshopTransport().signUpper ? "upper" : "lower",
    lastSuccess: s.lastOk ? { method: s.lastOk.method, at: s.lastOk.at, ms: s.lastOk.ms } : null,
    lastError: s.lastError ? { method: s.lastError.method, at: s.lastError.at, ms: s.lastError.ms, resultCode: s.lastError.resultCode, error: s.lastError.error } : null,
    lastStockSync: call("GetShopStocks") ? { at: call("GetShopStocks")!.at, ok: call("GetShopStocks")!.ok } : null,
    calls: [...s.calls.values()].sort((a, b) => b.at - a.at),
    writeMode,
    writeEnabledEnv: s.gate.writeEnabled,
    dryRunEnv: s.gate.dryRun,
    scope: s.scope,
    allowedShops: s.gate.shops.map((id) => ({ shopId: id, name: fridges.find((f) => f.shopId === id)?.name ?? null })),
    timeoutMs: s.gate.timeoutMs,
    paused: { on: st.writesPaused, by: st.pausedBy, at: st.pausedAt },
    counts: {
      pending: ops.filter((o) => o.status === "PENDING" || o.status === "DRAFT" || o.status === "WAITING_FOR_CONNECTION").length,
      unknown: ops.filter((o) => o.status === "UNKNOWN" || o.status === "REQUIRES_REVIEW").length,
      failed: ops.filter((o) => o.status === "FAILED").length,
      open: ops.filter((o) => OPEN_STATUSES.includes(o.status)).length,
    },
    fridges,
    testShop: st.testShop,
    testProduct: st.testProduct,
    liveBlocked: st.testShop ? liveBlocked(st.testShop.shopId) : "не выбрана тестовая точка",
    run: st.writeTest,
    summary: summarize(st.writeTest),
  };
}

/** ПРОВЕРИТЬ СОЕДИНЕНИЕ — read-only CheckAuth + GetShops. Detects which Sign case KiT Shop accepts. */
export async function checkConnection(rt: Runtime, user: string) {
  const s = kitshopServerInfo();
  if (!s.config.enabled) throw new HttpError(409, "KITSHOP_ENABLED не равен true — запросы к KiT Shop выключены");
  if (!s.config.companyId || !s.config.login || !s.config.password) throw new HttpError(409, "Не заданы KITSHOP_COMPANY_ID / KITSHOP_LOGIN / KITSHOP_PASSWORD в настройках сервера");
  const t = kitshopTransport();
  const reader = kitshopReader();
  const out: { auth: string; ms: number; signCase: string; shops: { shopId: string; name: string; stocksAccounting: boolean | null }[]; note: string | null } = {
    auth: "FAIL",
    ms: 0,
    signCase: t.signUpper ? "upper" : "lower",
    shops: [],
    note: null,
  };
  const t0 = Date.now();
  try {
    await reader.getAuthCheck();
    out.auth = "PASS";
  } catch (e) {
    // duck-typed: dev bundles may load the client module twice
    if ((e as { name?: string; code?: number }).name === "KitShopResultError" && (e as { code?: number }).code === 15) {
      // bad Sign: the docs show both cases — probe the other one (CheckAuth is read-only)
      t.signUpper = !t.signUpper;
      try {
        await reader.getAuthCheck();
        out.auth = "PASS";
        out.signCase = t.signUpper ? "upper" : "lower";
        out.note = `KiT Shop принимает Sign в регистре «${out.signCase}». Установите KITSHOP_SIGN_CASE=${out.signCase} в настройках сервера.`;
      } catch (e2) {
        t.signUpper = !t.signUpper;
        out.note = e2 instanceof Error ? e2.message : "ошибка";
      }
    } else {
      out.note = e instanceof Error ? e.message : "ошибка";
    }
  }
  out.ms = Date.now() - t0;
  if (out.auth === "PASS") {
    const shops = await reader.getShops();
    out.shops = shops.map((x) => ({ shopId: x.ShopId, name: x.ShopName, stocksAccounting: x.StocksAccounting === undefined || x.StocksAccounting === null ? null : !!x.StocksAccounting }));
  }
  rt.ops.audit(user, "kitshop.check_connection", "kitshop", "connection", { auth: out.auth, ms: out.ms, shops: out.shops.length });
  rt.save();
  return out;
}

/** TEST PRODUCT picker: current stock of the test shop + catalog search (read-only). */
export async function testProductCandidates(rt: Runtime, q: string) {
  const st = adminState(rt);
  if (!st.testShop) throw new HttpError(400, "Сначала выберите TEST SHOP");
  if (!kitshopServerInfo().config.enabled) throw new HttpError(409, "Чтение KiT Shop выключено на сервере (KITSHOP_ENABLED)");
  const reader = kitshopReader();
  const stocks = await reader.getShopStocks(st.testShop.shopId);
  const needle = q.trim().toLowerCase();
  let items = stocks.map((x) => ({ productId: x.ProductId, name: x.ProductName ?? `#${x.ProductId}`, barcode: x.Barcode ?? null, stock: x.Quantity }));
  if (needle) {
    const products = await reader.getProducts();
    const inStock = new Map(items.map((i) => [i.productId, i.stock]));
    items = products
      .filter((p) => p.ProductId === needle || (p.Barcode ?? "") === needle || p.ProductName.toLowerCase().includes(needle))
      .slice(0, 30)
      .map((p) => ({ productId: p.ProductId, name: p.ProductName, barcode: p.Barcode ?? null, stock: inStock.get(p.ProductId) ?? 0 }));
  }
  return { shop: st.testShop, items };
}
