import "server-only";
import dns from "node:dns";
import tls from "node:tls";
import type { KitShopConfig } from "./config";
import { KitShopReadOnlyClient } from "./kitshopClient";
import { DEFAULT_BASE_URL, KitShopTransport, KitShopTransportError, kitshopDate, parseKitshopDate, type CallRecord } from "./transport";

/**
 * REAL KiT Shop connectivity diagnostic — READ ONLY.
 * Uses the production transport + read client (same Auth / Sign / RequestId code as the app).
 * Calls only: CheckAuth, GetShops, GetShopStocks, GetSales. Never a write method.
 * Every layer is reported separately so a failure points at ONE category, never a generic "connection failed".
 * Never logs the password, the Sign value or the signing string.
 */

export type StepStatus = "PASS" | "FAIL" | "WARN" | "NOT_TESTED";
export type ErrorCategory = "NETWORK" | "AUTH" | "SIGNATURE" | "REQUEST_ID" | "PERMISSION" | "COMPANY_ID" | "ENDPOINT" | "DATA" | "TIMEOUT" | "CONFIG";
type Cell = string | number | boolean | null;

export interface StepResult {
  id: "https" | "endpoint" | "auth" | "requestId" | "permission" | "shops" | "stocks" | "sales";
  title: string;
  status: StepStatus;
  category: ErrorCategory | null;
  ms: number | null;
  message: string;
  details: Record<string, Cell>;
  rows?: Record<string, Cell>[];
}

export interface RealDiagnosticReport {
  kind: "REAL_KITSHOP_DIAGNOSTIC";
  at: number;
  environment: string;
  apiHost: string;
  /** false when KITSHOP_API_URL points somewhere else (e.g. a local fake) — results are then NOT real */
  realHost: boolean;
  steps: StepResult[];
  summary: Record<"transport" | "authentication" | "permission" | "company" | "shops" | "stocks" | "sales", StepStatus>;
  failingStep: string | null;
  failingCategory: ErrorCategory | null;
  signCaseAccepted: "lower" | "upper" | null;
}

export interface DiagnosticOptions {
  config: KitShopConfig;
  /** share the app's transport (one RequestId sequence); a new one is created otherwise */
  transport?: KitShopTransport;
  /** our KiT Shop ShopIds — used to prove we are connected to the RIGHT company */
  knownShopIds?: string[];
  testShopId?: string;
  /** wall-clock ms in the fridges' timezone (KiT Shop dates are local) */
  now: () => number;
  /** injectable for tests */
  network?: { lookup?: (host: string) => Promise<string[]>; tlsProbe?: (host: string) => Promise<Record<string, Cell>>; fetch?: typeof fetch };
}

export const REAL_API_HOST = "api.kitshop.ru";

/** KiT Shop ResultCode (Appendix 1) → category + plain explanation. */
export function categorizeResultCode(code: number): { category: ErrorCategory; text: string } | null {
  switch (code) {
    case 0:
      return null;
    case 9:
      return { category: "COMPANY_ID", text: "компания с таким CompanyId не найдена" };
    case 10:
      return { category: "COMPANY_ID", text: "компания заблокирована" };
    case 11:
      return { category: "AUTH", text: "пользователь с таким логином не найден" };
    case 12:
      return { category: "AUTH", text: "пользователь заблокирован" };
    case 13:
      return { category: "PERMISSION", text: "у пользователя нет прав на эту операцию (нужны права «API»)" };
    case 14:
      return { category: "REQUEST_ID", text: "неверный RequestId (должен расти с каждым запросом)" };
    case 15:
      return { category: "SIGNATURE", text: "неверная подпись Sign" };
    case 2:
      return { category: "ENDPOINT", text: "неверная структура JSON запроса" };
    case 3:
      return { category: "ENDPOINT", text: "ошибка чтения данных запроса — сервер не смог прочитать тело (заголовки / кодировка)" };
    case 4:
    case 5:
    case 6:
    case 7:
    case 8:
      return { category: "ENDPOINT", text: "неверный формат объекта Auth (пустое или нечисловое поле)" };
    case 28:
      return { category: "ENDPOINT", text: "не заполнены обязательные поля" };
    case 30:
      return { category: "ENDPOINT", text: "период больше 60 дней" };
    case 100:
      return { category: "DATA", text: "операция не выполнена / данных нет" };
    default:
      return { category: "ENDPOINT", text: `неизвестный код ответа KiT Shop ${code}` };
  }
}

export function categorizeError(e: unknown): { category: ErrorCategory; text: string; httpStatus: number | null } {
  if (e instanceof KitShopTransportError || (e as { name?: string })?.name === "KitShopTransportError") {
    const t = e as KitShopTransportError;
    const category: ErrorCategory = t.kind === "timeout" ? "TIMEOUT" : t.kind === "http" || t.kind === "malformed" ? "ENDPOINT" : "NETWORK";
    return { category, text: t.message, httpStatus: t.httpStatus ?? null };
  }
  const code = (e as { name?: string; code?: unknown })?.name === "KitShopResultError" ? Number((e as { code: unknown }).code) : null;
  if (code !== null) {
    const c = categorizeResultCode(code);
    return { category: c?.category ?? "ENDPOINT", text: `ResultCode ${code}: ${c?.text ?? ""} — ${(e as Error).message}`, httpStatus: null };
  }
  if ((e as { name?: string })?.name === "ZodError") return { category: "DATA", text: "ответ KiT Shop не совпал с ожидаемой структурой данных", httpStatus: null };
  return { category: "NETWORK", text: e instanceof Error ? e.message : String(e), httpStatus: null };
}

const mask = (v: string) => (!v ? "" : v.length <= 4 ? "•".repeat(v.length) : `${v.slice(0, 2)}${"•".repeat(Math.max(1, v.length - 4))}${v.slice(-2)}`);

function callDetails(c: CallRecord | null): Record<string, Cell> {
  if (!c) return {};
  return {
    method: c.method,
    httpStatus: c.httpStatus,
    contentType: c.contentType,
    responseMs: c.ms,
    resultCode: c.resultCode,
    kitshopMessage: c.resultCode !== null && c.resultCode !== 0 ? c.error : null,
    requestId: c.requestId,
    signCase: c.signCase,
    signLength: c.signLength,
  };
}

async function defaultLookup(host: string): Promise<string[]> {
  const res = await dns.promises.lookup(host, { all: true });
  return res.map((r) => r.address);
}

function defaultTlsProbe(host: string): Promise<Record<string, Cell>> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const socket = tls.connect({ host, port: 443, servername: host, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      const out = {
        tlsConnected: true,
        certificateValid: socket.authorized,
        certificateError: socket.authorizationError ? String(socket.authorizationError) : null,
        protocol: socket.getProtocol(),
        certSubject: typeof cert?.subject?.CN === "string" ? cert.subject.CN : null,
        certValidTo: cert?.valid_to ?? null,
        tlsMs: Date.now() - t0,
      };
      socket.end();
      resolve(out);
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(Object.assign(new Error("TLS handshake timeout"), { code: "TLS_TIMEOUT" }));
    });
    socket.on("error", reject);
  });
}

export async function runRealDiagnostic(opts: DiagnosticOptions): Promise<RealDiagnosticReport> {
  const cfg = opts.config;
  const base = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  let host = "";
  let protocol = "";
  try {
    const u = new URL(base);
    host = u.hostname;
    protocol = u.protocol;
  } catch {
    /* reported below */
  }
  const realHost = host === REAL_API_HOST;
  const steps: StepResult[] = [];
  const step = (s: StepResult) => (steps.push(s), s);
  const notTested = (id: StepResult["id"], title: string, why: string) => step({ id, title, status: "NOT_TESTED", category: null, ms: null, message: why, details: {} });

  // the reader must be allowed to send even if the app's KITSHOP_ENABLED is off — the caller decided to diagnose
  const transport = opts.transport ?? new KitShopTransport(cfg, { signUpper: process.env.KITSHOP_SIGN_CASE === "upper" });
  const reader = new KitShopReadOnlyClient({ ...cfg, enabled: true }, transport);
  const fetchImpl = opts.network?.fetch ?? fetch;

  // ── STEP A — DNS / TLS / HTTPS ──
  const a: StepResult = step({ id: "https", title: "DNS / HTTPS", status: "PASS", category: null, ms: null, message: "", details: { host, baseUrl: base } });
  const tA = Date.now();
  try {
    if (!host) throw Object.assign(new Error(`некорректный KITSHOP_API_URL`), { category: "CONFIG" });
    const t0 = Date.now();
    const addrs = await (opts.network?.lookup ?? defaultLookup)(host);
    a.details.dnsResolved = addrs.length > 0;
    a.details.addresses = addrs.slice(0, 4).join(", ");
    a.details.dnsMs = Date.now() - t0;
    if (protocol === "https:") Object.assign(a.details, await (opts.network?.tlsProbe ?? defaultTlsProbe)(host));
    else a.details.tlsConnected = "не HTTPS (локальный адрес?)";
    const t1 = Date.now();
    // plain GET of the host root: reachability only, no API method, no credentials
    const res = await fetchImpl(`${new URL(base).origin}/`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    a.details.httpStatus = res.status;
    a.details.httpMs = Date.now() - t1;
    a.message = `сервер отвечает (HTTP ${res.status})`;
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code ?? null;
    a.status = "FAIL";
    a.category = (e as { category?: ErrorCategory }).category ?? (code === "TLS_TIMEOUT" || (e as Error).name === "TimeoutError" ? "TIMEOUT" : "NETWORK");
    a.message = `${(e as Error).message}${code ? ` (${code})` : ""}`;
  }
  a.ms = Date.now() - tA;

  // ── STEP C (config) is checked before any authenticated call ──
  const configured = { companyIdConfigured: !!cfg.companyId, userLoginConfigured: !!cfg.login, passwordConfigured: !!cfg.password };
  let signCaseAccepted: "lower" | "upper" | null = null;
  let authOk = false;

  // ── STEP B — endpoint availability (CheckAuth: smallest documented read request) ──
  // ── STEP C — authentication, STEP D — RequestId ──
  if (a.status === "FAIL") {
    notTested("endpoint", "Эндпоинт CheckAuth", "транспорт недоступен");
    step({ id: "auth", title: "Аутентификация", status: "NOT_TESTED", category: null, ms: null, message: "транспорт недоступен", details: { ...configured } });
    notTested("requestId", "RequestId", "транспорт недоступен");
  } else if (!cfg.companyId || !cfg.login || !cfg.password) {
    notTested("endpoint", "Эндпоинт CheckAuth", "нет учётных данных");
    step({
      id: "auth",
      title: "Аутентификация",
      status: "FAIL",
      category: "CONFIG",
      ms: null,
      message: "не заданы KITSHOP_COMPANY_ID / KITSHOP_LOGIN / KITSHOP_PASSWORD на сервере",
      details: { ...configured },
    });
    notTested("requestId", "RequestId", "нет учётных данных");
  } else {
    const b = step({ id: "endpoint", title: "Эндпоинт CheckAuth", status: "PASS", category: null, ms: null, message: "", details: {} });
    const auth = step({ id: "auth", title: "Аутентификация", status: "FAIL", category: null, ms: null, message: "", details: { ...configured, companyId: mask(cfg.companyId), userLogin: mask(cfg.login) } });
    const rid = step({ id: "requestId", title: "RequestId", status: "PASS", category: null, ms: null, message: "", details: {} });
    const attempt = async (upper: boolean) => {
      try {
        const env = await transport.call("CheckAuth", {}, 20_000, { signUpper: upper });
        return { env, error: null };
      } catch (e) {
        return { env: null, error: e };
      }
    };
    let res = await attempt(transport.signUpper);
    let last = transport.lastCall;
    b.details.contentTypeSent = transport.contentType ?? "нет (как в документации)";
    // ResultCode 3 = the service could not read the body: compare with the other documented-compatible header variant
    if (!res.error && res.env!.ResultCode === 3) {
      const original = transport.contentType;
      transport.contentType = original ? null : "application/json; charset=utf-8";
      const retry = await attempt(transport.signUpper);
      b.details.retryContentType = transport.contentType ?? "нет";
      b.details.retryResult = retry.error ? categorizeError(retry.error).text : `ResultCode ${retry.env!.ResultCode}`;
      if (!retry.error && retry.env!.ResultCode !== 3) {
        res = retry;
        last = transport.lastCall;
        b.details.contentTypeAccepted = transport.contentType ?? "нет";
      } else transport.contentType = original;
    }
    b.ms = last?.ms ?? null;
    b.details = { endpoint: `POST ${base}/CheckAuth`, ...callDetails(last), ...b.details };
    if (res.error) {
      const c = categorizeError(res.error);
      b.status = "FAIL";
      b.category = c.category;
      b.message = c.text;
      auth.status = "NOT_TESTED";
      auth.message = "эндпоинт не ответил JSON-конвертом KiT Shop";
      rid.status = "NOT_TESTED";
      rid.message = auth.message;
    } else {
      b.message = `KiT Shop ответил JSON (ResultCode ${res.env!.ResultCode})`;
      // documented Sign variants only: lower / upper hex MD5
      if (res.env!.ResultCode === 15) {
        auth.details.firstSignCase = last?.signCase ?? null;
        auth.details.firstResult = "ResultCode 15 (неверная подпись)";
        const retry = await attempt(!transport.signUpper);
        if (!retry.error && retry.env!.ResultCode !== 15) {
          res = retry;
          last = transport.lastCall;
          transport.signUpper = !transport.signUpper; // this process only; the env var makes it permanent
        } else {
          last = transport.lastCall;
          auth.details.secondSignCase = last?.signCase ?? null;
          auth.details.secondResult = retry.error ? categorizeError(retry.error).text : `ResultCode ${retry.env!.ResultCode}`;
        }
      }
      const code = res.env!.ResultCode;
      Object.assign(auth.details, { requestId: last?.requestId ?? null, signCase: last?.signCase ?? null, signLength: last?.signLength ?? null, resultCode: code });
      auth.ms = last?.ms ?? null;
      rid.details = {
        generatedRequestId: last?.requestId ?? null,
        previousRequestId: last?.previousRequestId ?? null,
        monotonic: last?.previousRequestId == null || (last?.requestId ?? 0) > last.previousRequestId,
      };
      if (code === 0) {
        authOk = true;
        signCaseAccepted = last?.signCase ?? null;
        auth.status = "PASS";
        auth.message = `CheckAuth: ResultCode 0, Sign в регистре «${signCaseAccepted}»`;
        if (signCaseAccepted !== (process.env.KITSHOP_SIGN_CASE === "upper" ? "upper" : "lower"))
          auth.message += ` — установите KITSHOP_SIGN_CASE=${signCaseAccepted}`;
        rid.message = "RequestId принят KiT Shop";
      } else {
        const c = categorizeResultCode(code)!;
        auth.category = c.category;
        auth.message = `ResultCode ${code}: ${c.text}${res.env!.ErrorMessage ? ` — «${res.env!.ErrorMessage}»` : ""}`;
        if (code === 14) {
          rid.status = "FAIL";
          rid.category = "REQUEST_ID";
          rid.message = auth.message;
        } else rid.message = "KiT Shop не жаловался на RequestId";
      }
    }
  }

  // ── STEP E — permission & STEP F — shops (GetShops) ──
  let shopIds: { id: string; stocks: boolean | null }[] = [];
  let companyStatus: StepStatus = "NOT_TESTED";
  if (!authOk) {
    notTested("permission", "Права API-пользователя", "аутентификация не пройдена");
    notTested("shops", "Торговые точки", "аутентификация не пройдена");
  } else {
    const perm = step({ id: "permission", title: "Права API-пользователя", status: "PASS", category: null, ms: null, message: "", details: {} });
    const sh = step({ id: "shops", title: "Торговые точки", status: "PASS", category: null, ms: null, message: "", details: {} });
    try {
      const shops = await reader.getShops();
      perm.details = callDetails(transport.lastCall);
      perm.ms = sh.ms = transport.lastCall?.ms ?? null;
      perm.message = "чтение справочника точек разрешено (GetShops)";
      shopIds = shops.map((x) => ({ id: x.ShopId, stocks: x.StocksAccounting === undefined || x.StocksAccounting === null ? null : !!x.StocksAccounting }));
      sh.rows = shops.map((x) => ({
        ShopId: x.ShopId,
        name: x.ShopName,
        stocksAccounting: x.StocksAccounting === undefined || x.StocksAccounting === null ? null : !!x.StocksAccounting,
        ours: (opts.knownShopIds ?? []).includes(x.ShopId),
      }));
      const known = opts.knownShopIds ?? [];
      const matched = known.filter((id) => shopIds.some((s) => s.id === id));
      sh.details = { shopsReturned: shops.length, ourShopIdsFound: known.length ? `${matched.length} из ${known.length}` : "не с чем сравнить" };
      if (!shops.length) {
        sh.status = "WARN";
        sh.category = "DATA";
        sh.message = "KiT Shop вернул 0 точек (ResultCode 100)";
        companyStatus = "FAIL";
      } else if (known.length && !matched.length) {
        sh.status = "FAIL";
        sh.category = "COMPANY_ID";
        sh.message = "ни один из наших ShopId не найден — похоже, это другая компания (проверьте KITSHOP_COMPANY_ID)";
        companyStatus = "FAIL";
      } else {
        sh.message = `${shops.length} точек; наших найдено ${matched.length}`;
        companyStatus = known.length ? "PASS" : "WARN";
      }
    } catch (e) {
      const c = categorizeError(e);
      perm.details = sh.details = callDetails(transport.lastCall);
      perm.status = sh.status = "FAIL";
      perm.category = sh.category = c.category;
      perm.message = sh.message = c.text;
      if (c.category === "COMPANY_ID") companyStatus = "FAIL";
    }
  }

  // ── STEP G — stocks of ONE shop ──
  const shopsStep = steps.find((s) => s.id === "shops");
  if (!authOk || !shopsStep || shopsStep.status === "FAIL" || !shopIds.length) {
    notTested("stocks", "Остатки одной точки", "нет списка точек");
  } else {
    const known = opts.knownShopIds ?? [];
    const shopId = opts.testShopId || known.find((id) => shopIds.some((s) => s.id === id)) || shopIds[0].id;
    const st = step({ id: "stocks", title: "Остатки одной точки", status: "PASS", category: null, ms: null, message: "", details: { shopId } });
    try {
      const stocks = await reader.getShopStocks(shopId);
      Object.assign(st.details, callDetails(transport.lastCall), { rows: stocks.length });
      st.ms = transport.lastCall?.ms ?? null;
      st.rows = stocks.slice(0, 10).map((x) => ({ ProductId: x.ProductId, quantity: x.Quantity }));
      if (!stocks.length) {
        const accounting = shopIds.find((s) => s.id === shopId)?.stocks;
        st.status = "WARN";
        st.category = "DATA";
        st.message = accounting === false ? "учёт остатков на этой точке выключен (StocksAccounting = false)" : "0 строк (ResultCode 100: остатков нет или учёт не ведётся)";
      } else st.message = `${stocks.length} товаров в остатках, показаны первые ${Math.min(10, stocks.length)}`;
    } catch (e) {
      const c = categorizeError(e);
      Object.assign(st.details, callDetails(transport.lastCall));
      st.status = "FAIL";
      st.category = c.category;
      st.message = c.text;
    }
  }

  // ── STEP H — sales in a tiny window ──
  if (!authOk || !shopsStep || shopsStep.status === "FAIL") {
    notTested("sales", "Продажи за последний час", "аутентификация / точки не пройдены");
  } else {
    const sa = step({ id: "sales", title: "Продажи за последний час", status: "PASS", category: null, ms: null, message: "", details: {} });
    const to = opts.now();
    try {
      const hour = await reader.getSales({ from: to - 3_600_000, to });
      const times = hour.map((x) => (typeof x.SaleDateTime === "string" ? parseKitshopDate(x.SaleDateTime) : null)).filter((x): x is number => x !== null).sort((x, y) => x - y);
      Object.assign(sa.details, callDetails(transport.lastCall), {
        window: `${kitshopDate(to - 3_600_000)} — ${kitshopDate(to)} (время Алматы)`,
        sales: hour.length,
        first: times.length ? kitshopDate(times[0]) : null,
        last: times.length ? kitshopDate(times[times.length - 1]) : null,
      });
      sa.ms = transport.lastCall?.ms ?? null;
      if (hour.length) sa.message = `${hour.length} продаж за последний час`;
      else {
        // still tiny: one day, only to tell "no data flows" from "quiet hour / other timezone"
        const day = await reader.getSales({ from: to - 86_400_000, to });
        sa.details.salesLast24h = day.length;
        sa.status = day.length ? "PASS" : "WARN";
        sa.category = day.length ? null : "DATA";
        sa.message = day.length
          ? `за последний час 0, за 24 часа ${day.length} — данные идут (тихий час или другое время KiT Shop)`
          : "0 продаж за последний час и за 24 часа — проверьте точки и часовой пояс";
      }
    } catch (e) {
      const c = categorizeError(e);
      Object.assign(sa.details, callDetails(transport.lastCall));
      sa.status = "FAIL";
      sa.category = c.category;
      sa.message = c.text;
    }
  }

  const st = (id: StepResult["id"]) => steps.find((s) => s.id === id)?.status ?? "NOT_TESTED";
  const authStep = steps.find((s) => s.id === "auth");
  const summary: RealDiagnosticReport["summary"] = {
    transport: st("https") === "FAIL" || st("endpoint") === "FAIL" ? "FAIL" : st("endpoint") === "NOT_TESTED" ? st("https") : "PASS",
    authentication: st("auth"),
    permission: st("permission"),
    company: authStep?.category === "COMPANY_ID" ? "FAIL" : companyStatus,
    shops: st("shops"),
    stocks: st("stocks"),
    sales: st("sales"),
  };
  const failing = steps.find((s) => s.status === "FAIL");
  return {
    kind: "REAL_KITSHOP_DIAGNOSTIC",
    at: Date.now(),
    environment: process.env.RENDER === "true" ? `Render production${process.env.RENDER_SERVICE_NAME ? ` (${process.env.RENDER_SERVICE_NAME})` : ""}` : "local",
    apiHost: host || "(не задан)",
    realHost,
    steps,
    summary,
    failingStep: failing ? failing.title : null,
    failingCategory: failing?.category ?? null,
    signCaseAccepted,
  };
}

/** Plain-text report (script output / logs). Contains no credentials. */
export function formatReport(r: RealDiagnosticReport): string {
  const lines: string[] = [];
  lines.push(`${r.realHost ? "REAL KITSHOP" : "NOT THE REAL KITSHOP HOST"} DIAGNOSTIC · ${new Date(r.at).toISOString()}`);
  lines.push(`Environment: ${r.environment}`);
  lines.push(`API host: ${r.apiHost}`);
  for (const [k, v] of Object.entries(r.summary)) lines.push(`${k.padEnd(15)} ${v}`);
  lines.push(r.failingStep ? `FAILING STEP: ${r.failingStep} [${r.failingCategory}]` : "No failing step.");
  for (const s of r.steps) {
    lines.push("");
    lines.push(`── ${s.title}: ${s.status}${s.category ? ` [${s.category}]` : ""}${s.ms !== null ? ` · ${s.ms} ms` : ""}`);
    if (s.message) lines.push(`   ${s.message}`);
    for (const [k, v] of Object.entries(s.details)) if (v !== null && v !== "") lines.push(`   ${k}: ${v}`);
    for (const row of s.rows ?? []) lines.push(`   · ${Object.entries(row).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  }
  return lines.join("\n");
}
