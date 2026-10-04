import { createHash } from "node:crypto";
import type { KitShopConfig } from "./config";

/**
 * KiT Shop wire protocol, per the official docs v1.3 (see docs/KITSHOP_WRITE_API_AUDIT.md):
 *  • every method is POST https://api.kitshop.ru/APIService.svc/{Method} with a JSON body;
 *  • body.Auth = { CompanyId, RequestId, UserLogin, Sign = MD5(CompanyId + Password + RequestId) };
 *  • RequestId must be strictly greater than in the previous request → one request at a time.
 * This module knows nothing about which methods are allowed — the read client and the gated writer decide.
 * Credentials come from server env only; the password is used for Sign and never logged.
 */

export const DEFAULT_BASE_URL = "https://api.kitshop.ru/APIService.svc";

/** Result codes from Appendix 1 that mean "the request was processed and rejected" (nothing was applied). */
export const DEFINITE_REJECT_CODES = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 30, 31, 32, 33, 34, 40, 41, 42, 51, 60, 61, 70, 100,
]);

export interface KitShopEnvelope {
  ResultCode: number;
  ErrorMessage?: string;
  Response?: string;
  [k: string]: unknown;
}

/**
 * Why a call did not produce an answer. "unreachable" = provably never sent (safe to send again).
 * "malformed" = HTTP answer arrived but is not a KiT Shop JSON envelope (e.g. an HTML error page).
 */
export type TransportFailure = "unreachable" | "timeout" | "lost" | "http" | "malformed";

export class KitShopTransportError extends Error {
  constructor(
    public kind: TransportFailure,
    message: string,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = "KitShopTransportError";
  }
}

/**
 * Strictly increasing RequestId in the docs' example format yyMMddHHmmssfff (e.g. 210624131945394).
 * (The ddMMyyyyHHmmss variant from the docs' text does NOT increase across days.)
 */
export function createRequestIdGenerator(clock: () => Date = () => new Date()) {
  let last = 0;
  return (): number => {
    const d = clock();
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    const id = Number(
      `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds(), 3)}`,
    );
    last = id > last ? id : last + 1;
    return last;
  };
}

/** Sign = MD5(CompanyId + Password + RequestId), hex. The docs show both cases; KITSHOP_SIGN_CASE picks one (checked by the diagnostics). */
export function signRequest(companyId: string | number, password: string, requestId: number, upper = false): string {
  const hex = createHash("md5").update(`${companyId}${password}${requestId}`, "utf8").digest("hex");
  return upper ? hex.toUpperCase() : hex;
}

/** Outcome of every call — for the diagnostics page (no bodies, no credentials). */
type MetaKeys = "requestId" | "previousRequestId" | "signCase" | "signLength" | "httpStatus" | "contentType" | "requestPreview" | "headersSent" | "bodyBytes";

/** Bad server configuration (e.g. CompanyId with quotes) — detected before anything is sent. */
export class KitShopConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KitShopConfigError";
  }
}

export interface AuthObject {
  CompanyId: number;
  RequestId: number;
  UserLogin: string;
  Sign: string;
}

/**
 * The request body exactly as in the official examples: { "Auth": { CompanyId, RequestId, UserLogin, Sign }, ...params }.
 * CompanyId / RequestId are JSON numbers; the object is serialized ONCE.
 */
export function buildRequestBody(auth: AuthObject, params: Record<string, unknown> = {}): string {
  if (!Number.isSafeInteger(auth.CompanyId) || auth.CompanyId <= 0) throw new KitShopConfigError("KITSHOP_COMPANY_ID должен быть целым числом без кавычек и пробелов");
  if (!Number.isSafeInteger(auth.RequestId) || auth.RequestId <= 0) throw new KitShopConfigError("RequestId вне безопасного диапазона целых чисел");
  if (!auth.UserLogin) throw new KitShopConfigError("KITSHOP_LOGIN пустой");
  return JSON.stringify({ Auth: { CompanyId: auth.CompanyId, RequestId: auth.RequestId, UserLogin: auth.UserLogin, Sign: auth.Sign }, ...params });
}

/** Same body with the login masked and the Sign replaced by its length — safe to show and log. */
export function sanitizedRequestPreview(bodyJson: string): string {
  const parsed = JSON.parse(bodyJson) as { Auth?: Partial<AuthObject> } & Record<string, unknown>;
  const a = parsed.Auth ?? {};
  const login = typeof a.UserLogin === "string" ? a.UserLogin : "";
  const masked = login.length <= 4 ? "•".repeat(login.length) : `${login.slice(0, 2)}${"•".repeat(login.length - 4)}${login.slice(-2)}`;
  return JSON.stringify({ ...parsed, Auth: { ...a, UserLogin: masked, Sign: typeof a.Sign === "string" ? `<${a.Sign.length} chars>` : a.Sign } });
}

export interface CallRecord {
  method: string;
  at: number;
  ms: number;
  ok: boolean;
  resultCode: number | null;
  error: string | null;
  /** diagnostics only — never the password, the Sign value or the signing string */
  requestId: number | null;
  previousRequestId: number | null;
  signCase: "lower" | "upper";
  signLength: number | null;
  httpStatus: number | null;
  contentType: string | null;
  /** body with masked login and "<32 chars>" instead of the Sign */
  requestPreview: string | null;
  /** headers WE set (fetch adds Host / Content-Length itself) */
  headersSent: string | null;
  bodyBytes: number | null;
  failure: TransportFailure | null;
}

/** dd.MM.yyyy HH:mm:ss from our wall-clock ms (UTC fields = local time). */
export function kitshopDate(wallClockMs: number): string {
  const d = new Date(wallClockMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** Parses dd.MM.yyyy HH:mm:ss into wall-clock ms. */
export function parseKitshopDate(s: string): number | null {
  const m = /^(\d\d)\.(\d\d)\.(\d{4}) (\d\d):(\d\d):(\d\d)$/.exec(s.trim());
  if (!m) return null;
  return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** KITSHOP_CONTENT_TYPE: unset / "none" = no header (documented); "json" = application/json; anything else = sent as is. */
export function contentTypeFromEnv(v = process.env.KITSHOP_CONTENT_TYPE): string | null {
  if (!v || v === "none") return null;
  return v === "json" ? "application/json; charset=utf-8" : v;
}

/** connection never established → the request provably did not reach KiT Shop */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

export class KitShopTransport {
  readonly #config: KitShopConfig;
  readonly #fetch: FetchLike;
  readonly #nextRequestId: () => number;
  readonly #onCall?: (r: CallRecord) => void;
  #queue: Promise<unknown> = Promise.resolve();
  #lastRequestId: number | null = null;
  /** details of the exchange in progress (filled by #send, reported through onCall / lastCall) */
  #meta: Pick<CallRecord, MetaKeys> = {
    requestId: null,
    previousRequestId: null,
    signCase: "lower",
    signLength: null,
    httpStatus: null,
    contentType: null,
    requestPreview: null,
    headersSent: null,
    bodyBytes: null,
  };
  /** the last finished call (diagnostics) */
  lastCall: CallRecord | null = null;
  /** Sign in upper case (KITSHOP_SIGN_CASE=upper); can be switched by the diagnostics after a CheckAuth probe */
  signUpper: boolean;

  constructor(
    config: KitShopConfig,
    opts: {
      fetch?: FetchLike;
      nextRequestId?: () => number;
      onCall?: (r: CallRecord) => void;
      signUpper?: boolean;
      /** Content-Type header; null (default) = none, exactly like the official examples (only Host + Content-Length) */
      contentType?: string | null;
    } = {},
  ) {
    this.#config = config;
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.#nextRequestId = opts.nextRequestId ?? createRequestIdGenerator();
    this.#onCall = opts.onCall;
    this.signUpper = opts.signUpper ?? false;
    this.contentType = opts.contentType === undefined ? contentTypeFromEnv() : opts.contentType;
  }

  /**
   * KiT Shop docs: requests carry only Host + Content-Length ("отключить все заголовки кроме Content-Length и Host").
   * With "Content-Type: application/json" the service answered ResultCode 3 "Ошибка чтения данных запроса".
   */
  contentType: string | null;

  /** Serialized: RequestId order = arrival order. */
  call(method: string, params: Record<string, unknown>, timeoutMs = 20_000, opts: { signUpper?: boolean } = {}): Promise<KitShopEnvelope> {
    const run = this.#queue.then(async () => {
      const t0 = Date.now();
      const record = (r: Omit<CallRecord, MetaKeys | "method" | "at" | "ms">) => {
        this.lastCall = { method, at: t0, ms: Date.now() - t0, ...this.#meta, ...r };
        this.#onCall?.(this.lastCall);
      };
      try {
        const env = await this.#send(method, params, timeoutMs, opts.signUpper ?? this.signUpper);
        record({
          ok: env.ResultCode === 0 || env.ResultCode === 100,
          resultCode: env.ResultCode,
          error: env.ResultCode === 0 ? null : (env.ErrorMessage ?? env.Response ?? null),
          failure: null,
        });
        return env;
      } catch (e) {
        record({
          ok: false,
          resultCode: null,
          error: e instanceof Error ? e.message : "error",
          failure: e instanceof KitShopTransportError ? e.kind : e instanceof KitShopConfigError ? null : "lost",
        });
        throw e;
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #send(method: string, params: Record<string, unknown>, timeoutMs: number, signUpper: boolean): Promise<KitShopEnvelope> {
    const c = this.#config;
    this.#meta = {
      requestId: null,
      previousRequestId: this.#lastRequestId,
      signCase: signUpper ? "upper" : "lower",
      signLength: null,
      httpStatus: null,
      contentType: null,
      requestPreview: null,
      headersSent: null,
      bodyBytes: null,
    };
    if (!c.companyId || !c.login || !c.password) throw new KitShopTransportError("unreachable", "KiT Shop credentials are not configured");
    if (!/^\d+$/.test(c.companyId)) throw new KitShopConfigError("KITSHOP_COMPANY_ID должен состоять только из цифр (без кавычек и пробелов)");
    const requestId = this.#nextRequestId();
    const sign = signRequest(c.companyId, c.password, requestId, signUpper);
    this.#meta.requestId = requestId;
    this.#meta.signLength = sign.length;
    this.#lastRequestId = requestId;
    const bodyJson = buildRequestBody({ CompanyId: Number(c.companyId), RequestId: requestId, UserLogin: c.login, Sign: sign }, params);
    const bytes = new TextEncoder().encode(bodyJson);
    const headers: Record<string, string> = this.contentType ? { "Content-Type": this.contentType } : {};
    this.#meta.requestPreview = sanitizedRequestPreview(bodyJson);
    this.#meta.headersSent = Object.keys(headers).length ? Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("; ") : "нет (fetch добавит Host и Content-Length)";
    this.#meta.bodyBytes = bytes.length;
    const base = (c.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(`${base}/${method}`, {
        method: "POST",
        // raw bytes: fetch adds no Content-Type of its own for a Uint8Array body (a string body would become text/plain)
        headers,
        body: bytes,
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (e) {
      clearTimeout(timer);
      const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
      if (code && NOT_SENT_CODES.has(code)) throw new KitShopTransportError("unreachable", `KiT Shop unreachable (${code})`);
      if (controller.signal.aborted) throw new KitShopTransportError("timeout", `KiT Shop ${method}: no answer in ${timeoutMs} ms`);
      throw new KitShopTransportError("lost", `KiT Shop ${method}: connection lost`);
    }
    this.#meta.httpStatus = res.status;
    this.#meta.contentType = res.headers.get("content-type");
    try {
      if (!res.ok) throw new KitShopTransportError("http", `KiT Shop ${method}: HTTP ${res.status}`, res.status);
      let text: string;
      try {
        text = await res.text();
      } catch {
        throw new KitShopTransportError(controller.signal.aborted ? "timeout" : "lost", `KiT Shop ${method}: answer not received completely`);
      }
      let json: KitShopEnvelope;
      try {
        json = JSON.parse(text.replace(/^\uFEFF/, "")) as KitShopEnvelope;
      } catch {
        throw new KitShopTransportError("malformed", `KiT Shop ${method}: answer is not JSON (${this.#meta.contentType ?? "no content-type"})`);
      }
      if (typeof json?.ResultCode !== "number") throw new KitShopTransportError("malformed", `KiT Shop ${method}: JSON without ResultCode`);
      return json;
    } catch (e) {
      if (e instanceof KitShopTransportError) throw e;
      throw new KitShopTransportError(controller.signal.aborted ? "timeout" : "lost", `KiT Shop ${method}: answer not received completely`);
    } finally {
      clearTimeout(timer);
    }
  }
}
