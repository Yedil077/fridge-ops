import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { catalogHealth, resolveMapping, type CatalogItem } from "../src/lib/kitshop-ops/mapping";
import { createRequestIdGenerator, KitShopTransport, KitShopTransportError, kitshopDate, parseKitshopDate, signRequest } from "../src/services/kitshop/transport";

const config = { enabled: true, baseUrl: "https://example.invalid/APIService.svc", companyId: "9", login: "user2021", password: "secret" };

test("Sign = MD5(CompanyId + Password + RequestId)", () => {
  assert.equal(signRequest("1", "fdekKeEc121", 171026124501), createHash("md5").update("1fdekKeEc121171026124501").digest("hex"));
});

test("RequestId is yyMMddHHmmssfff and strictly increasing, also across days and within one ms", () => {
  let now = new Date(Date.UTC(2026, 8, 30, 23, 59, 59, 999));
  const next = createRequestIdGenerator(() => now);
  const a = next();
  assert.equal(a, 260930235959999);
  const b = next();
  assert.ok(b > a);
  now = new Date(Date.UTC(2026, 9, 1, 0, 0, 0, 0));
  assert.ok(next() > b, "01.10 must be greater than 30.09 (ddMMyyyy would fail here)");
});

test("dates use dd.MM.yyyy HH:mm:ss both ways", () => {
  const t = Date.UTC(2026, 9, 1, 8, 5, 9);
  assert.equal(kitshopDate(t), "01.10.2026 08:05:09");
  assert.equal(parseKitshopDate("01.10.2026 08:05:09"), t);
});

test("transport: POST with Auth in the body, serialized requests, password never in the URL", async () => {
  const seen: { url: string; body: { Auth: { RequestId: number; Sign: string; CompanyId: number } } }[] = [];
  const fakeFetch = async (url: string, init: RequestInit) => {
    assert.equal(init.method, "POST");
    seen.push({ url, body: JSON.parse(String(init.body)) });
    await new Promise((r) => setTimeout(r, 5));
    return new Response(JSON.stringify({ ResultCode: 0, Response: "AuthSucces" }), { status: 200 });
  };
  const t = new KitShopTransport(config, { fetch: fakeFetch });
  await Promise.all([t.call("CheckAuth", {}), t.call("GetShops", {})]);
  assert.equal(seen[0].url, "https://example.invalid/APIService.svc/CheckAuth");
  assert.ok(seen[1].body.Auth.RequestId > seen[0].body.Auth.RequestId);
  assert.equal(seen[0].body.Auth.CompanyId, 9);
  assert.equal(seen[0].body.Auth.Sign, signRequest("9", "secret", seen[0].body.Auth.RequestId));
  assert.ok(!seen.some((s) => s.url.includes("secret") || JSON.stringify(s.body).includes("secret")));
});

test("transport: connection refused = unreachable (not sent); abort = timeout (maybe sent)", async () => {
  const refused = new KitShopTransport(config, {
    fetch: async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    },
  });
  await assert.rejects(refused.call("MakeFillUp", {}), (e: unknown) => e instanceof KitShopTransportError && e.kind === "unreachable");
  const hanging = new KitShopTransport(config, {
    fetch: (_u, init) =>
      new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
  });
  await assert.rejects(hanging.call("MakeFillUp", {}, 20), (e: unknown) => e instanceof KitShopTransportError && e.kind === "timeout");
});

const catalog: CatalogItem[] = [
  { productId: "100", name: "Плов с говядиной", barcode: "4600000000001", vendorCode: "ГР-01" },
  { productId: "101", name: "Плов с курицей", barcode: "4600000000002", vendorCode: "ГР-02" },
  { productId: "102", name: "Цезарь", barcode: "DUP", vendorCode: null },
  { productId: "103", name: "Цезарь с креветками", barcode: "DUP", vendorCode: null },
];

test("mapping: barcode, then vendor code; a confirmed id wins", () => {
  assert.deepEqual(resolveMapping({ id: "P1", name: "x", barcode: "4600000000002", sku: null }, catalog), { status: "MAPPED", kitshopProductId: "101", matchedBy: "barcode" });
  assert.deepEqual(resolveMapping({ id: "P1", name: "x", barcode: null, sku: "ГР-01" }, catalog), { status: "MAPPED", kitshopProductId: "100", matchedBy: "vendor_code" });
  const confirmed = { kitshopProductId: "103", matchedBy: "manual" as const, confirmedBy: "admin", at: 0 };
  assert.equal(resolveMapping({ id: "P1", name: "x", barcode: "DUP", sku: null }, catalog, confirmed).status, "MAPPED");
});

test("mapping: similar names are only suggestions; duplicates are ambiguous", () => {
  const byName = resolveMapping({ id: "P1", name: "Плов с говядиной", barcode: null, sku: null }, catalog);
  assert.equal(byName.status, "MAPPING_REQUIRED");
  assert.equal(byName.status === "MAPPING_REQUIRED" && byName.suggestions[0].productId, "100");
  const dup = resolveMapping({ id: "P1", name: "Цезарь", barcode: "DUP", sku: null }, catalog);
  assert.equal(dup.status === "MAPPING_REQUIRED" && dup.reason, "ambiguous");
  const stale = resolveMapping({ id: "P1", name: "x", barcode: null, sku: null }, catalog, { kitshopProductId: "999", matchedBy: "manual", confirmedBy: "a", at: 0 });
  assert.equal(stale.status === "MAPPING_REQUIRED" && stale.reason, "stale");
});

test("catalog health counts", () => {
  const h = catalogHealth(
    [
      { id: "A", name: "Плов", barcode: "4600000000001", sku: null },
      { id: "B", name: "Цезарь", barcode: "DUP", sku: null },
      { id: "C", name: "Новое блюдо", barcode: null, sku: null },
    ],
    catalog,
    {},
  );
  assert.equal(h.mapped, 1);
  assert.equal(h.ambiguous, 1);
  assert.equal(h.mappingRequired, 2);
  assert.equal(h.missingBarcode, 1);
  assert.deepEqual(h.duplicateBarcodes, ["DUP"]);
});
