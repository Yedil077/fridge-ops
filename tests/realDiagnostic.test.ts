import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { categorizeResultCode, formatReport, runRealDiagnostic } from "../src/services/kitshop/realDiagnostic";
import { KitShopTransport } from "../src/services/kitshop/transport";

/** REAL API diagnostic logic against a scripted fake HTTP layer — no network, no KiT Shop. */

const config = { enabled: false, baseUrl: "https://api.kitshop.ru/APIService.svc", companyId: "108943", login: "api-user", password: "s3cret-pass" };
const OUR = ["621583", "621826"];

type Mode = "ok" | "upper" | "company" | "rights" | "requestId" | "refused" | "html";

function fakeFetch(mode: Mode, calls: string[]) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (mode === "refused") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    if (!init || init.method === "GET") return new Response("<html>KiT Shop</html>", { status: 200, headers: { "content-type": "text/html" } });
    const method = u.split("/").pop()!;
    calls.push(method);
    if (mode === "html") return new Response("<html>Service unavailable</html>", { status: 200, headers: { "content-type": "text/html" } });
    const body = JSON.parse(String(init.body));
    const a = body.Auth;
    const lower = createHash("md5").update(`${a.CompanyId}${config.password}${a.RequestId}`).digest("hex");
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    if (mode === "company") return json({ ResultCode: 9, ErrorMessage: "Компания с таким Id не найдена" });
    if (mode === "requestId") return json({ ResultCode: 14, ErrorMessage: "Неверный RequestId" });
    const expected = mode === "upper" ? lower.toUpperCase() : lower;
    if (a.Sign !== expected) return json({ ResultCode: 15, ErrorMessage: "Неверная подпись" });
    if (method === "CheckAuth") return json({ ResultCode: 0, Response: "AuthSucces" });
    if (mode === "rights") return json({ ResultCode: 13, ErrorMessage: "Нет прав на выполнение операции" });
    if (method === "GetShops") return json({ ResultCode: 0, Shops: [{ ShopId: 621583, ShopName: "5 БЦ Сатти 1 этаж", StocksAccounting: true }, { ShopId: 999, ShopName: "Чужая", StocksAccounting: false }] });
    if (method === "GetShopStocks") return json({ ResultCode: 0, Stocks: Array.from({ length: 12 }, (_, i) => ({ ProductId: 810000 + i, Quantity: i })) });
    if (method === "GetSales") return json({ ResultCode: 0, Sales: [{ SaleId: 1, ShopId: 621583, SaleDateTime: "02.10.2026 11:40:00" }, { SaleId: 2, ShopId: 621583, SaleDateTime: "02.10.2026 11:05:00" }] });
    return json({ ResultCode: 1, ErrorMessage: "fake: unexpected method" });
  }) as typeof fetch;
}

async function run(mode: Mode) {
  const calls: string[] = [];
  const f = fakeFetch(mode, calls);
  const transport = new KitShopTransport(config, { fetch: (u, i) => f(u, i) });
  const report = await runRealDiagnostic({
    config,
    transport,
    knownShopIds: OUR,
    now: () => Date.UTC(2026, 9, 2, 12, 0),
    network: {
      lookup: async () => (mode === "refused" ? Promise.reject(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })) : ["1.2.3.4"]),
      tlsProbe: async () => ({ tlsConnected: true, certificateValid: true, protocol: "TLSv1.3", tlsMs: 30 }),
      fetch: f,
    },
  });
  return { report, calls };
}

const step = (r: Awaited<ReturnType<typeof run>>["report"], id: string) => r.steps.find((s) => s.id === id)!;

test("all steps PASS on a healthy account; only read methods are called", async () => {
  const { report, calls } = await run("ok");
  assert.deepEqual(report.summary, { transport: "PASS", authentication: "PASS", permission: "PASS", company: "PASS", shops: "PASS", stocks: "PASS", sales: "PASS" });
  assert.equal(report.failingStep, null);
  assert.equal(report.realHost, true);
  assert.deepEqual([...new Set(calls)].sort(), ["CheckAuth", "GetSales", "GetShopStocks", "GetShops"]);
  assert.equal(step(report, "stocks").rows!.length, 10, "max 10 products printed");
  assert.equal(step(report, "stocks").details.shopId, "621583", "our shop picked automatically");
  assert.equal(step(report, "sales").details.sales, 2);
  assert.equal(step(report, "sales").details.first, "02.10.2026 11:05:00");
  assert.equal(step(report, "auth").details.signLength, 32);
  assert.equal(step(report, "requestId").details.monotonic, true);
});

test("the report never contains the password or a Sign value", async () => {
  const { report } = await run("ok");
  const text = JSON.stringify(report) + formatReport(report);
  assert.doesNotMatch(text, /s3cret-pass/);
  assert.doesNotMatch(text, /[0-9a-f]{32}/i, "no MD5 hex anywhere");
  assert.doesNotMatch(text, /108943/, "company id is masked");
});

test("Sign accepted only in upper case → detected, PASS, tells which case to configure", async () => {
  const { report } = await run("upper");
  assert.equal(report.summary.authentication, "PASS");
  assert.equal(report.signCaseAccepted, "upper");
  assert.match(step(report, "auth").message, /KITSHOP_SIGN_CASE=upper/);
});

test("wrong CompanyId → COMPANY_ID, later steps NOT TESTED", async () => {
  const { report } = await run("company");
  assert.equal(step(report, "auth").category, "COMPANY_ID");
  assert.equal(report.summary.company, "FAIL");
  assert.equal(report.summary.shops, "NOT_TESTED");
  assert.equal(report.failingCategory, "COMPANY_ID");
});

test("no API rights → PERMISSION on the first data read", async () => {
  const { report } = await run("rights");
  assert.equal(report.summary.authentication, "PASS");
  assert.equal(step(report, "permission").category, "PERMISSION");
  assert.equal(report.summary.permission, "FAIL");
});

test("RequestId rejected → REQUEST_ID with KiT Shop's message", async () => {
  const { report } = await run("requestId");
  assert.equal(step(report, "requestId").status, "FAIL");
  assert.equal(step(report, "requestId").category, "REQUEST_ID");
  assert.match(step(report, "requestId").message, /ResultCode 14/);
});

test("network down → NETWORK at HTTPS, nothing else claimed", async () => {
  const { report } = await run("refused");
  assert.equal(step(report, "https").status, "FAIL");
  assert.equal(step(report, "https").category, "NETWORK");
  assert.equal(report.summary.transport, "FAIL");
  assert.ok(["auth", "shops", "stocks", "sales"].every((id) => step(report, id).status !== "PASS"));
});

test("HTML instead of a KiT Shop JSON envelope → ENDPOINT, not 'connection failed'", async () => {
  const { report } = await run("html");
  assert.equal(step(report, "endpoint").category, "ENDPOINT");
  assert.equal(step(report, "endpoint").details.contentType, "text/html");
});

test("ResultCode categories follow Appendix 1", () => {
  assert.equal(categorizeResultCode(11)!.category, "AUTH");
  assert.equal(categorizeResultCode(13)!.category, "PERMISSION");
  assert.equal(categorizeResultCode(15)!.category, "SIGNATURE");
  assert.equal(categorizeResultCode(0), null);
});
