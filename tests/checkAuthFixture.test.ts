import { test } from "node:test";
import assert from "node:assert/strict";
import { KitShopTransport, KitShopConfigError, sanitizedRequestPreview } from "../src/services/kitshop/transport";

/**
 * Byte-level comparison of OUR CheckAuth request with the official example (KiT Shop API v1.3, §3.1):
 *
 *   POST https://api.kitshop.ru/APIService.svc/CheckAuth HTTP/1.1
 *   Host: api.kitshop.ru
 *   Content-Length: 189
 *
 *   { "Auth": { "CompanyId": 9, "RequestId": 210601124223282, "UserLogin": "user2021", "Sign": "395b0065fe2b2f254adf787ff8eceec4" } }
 */
const OFFICIAL = {
  url: "https://api.kitshop.ru/APIService.svc/CheckAuth",
  body: { Auth: { CompanyId: 9, RequestId: 210601124223282, UserLogin: "user2021", Sign: "395b0065fe2b2f254adf787ff8eceec4" } },
};

function capture(companyId = "9") {
  const sent: { url: string; init: RequestInit; text: string }[] = [];
  const t = new KitShopTransport(
    { enabled: true, baseUrl: "https://api.kitshop.ru/APIService.svc", companyId, login: "user2021", password: "any-password" },
    {
      nextRequestId: () => 210601124223282,
      fetch: async (url, init) => {
        sent.push({ url, init, text: new TextDecoder().decode(init.body as Uint8Array) });
        return new Response(JSON.stringify({ ResultCode: 0, Response: "AuthSucces" }), { status: 200 });
      },
    },
  );
  return { t, sent };
}

test("our CheckAuth request has exactly the official structure and types", async () => {
  const { t, sent } = capture();
  await t.call("CheckAuth", {});
  const { url, init, text } = sent[0];
  assert.equal(url, OFFICIAL.url);
  assert.equal(init.method, "POST");
  // 1, 5, 6, 7: one {"Auth": {...}} object, no wrapper, serialized once, Auth is an object
  assert.match(text, /^\{"Auth":\{"CompanyId":9,"RequestId":210601124223282,"UserLogin":"user2021","Sign":"[0-9a-f]{32}"\}\}$/);
  const ours = JSON.parse(text);
  assert.deepEqual(Object.keys(ours), Object.keys(OFFICIAL.body));
  assert.deepEqual(Object.keys(ours.Auth), Object.keys(OFFICIAL.body.Auth), "same fields, same order");
  for (const k of Object.keys(OFFICIAL.body.Auth) as (keyof typeof OFFICIAL.body.Auth)[])
    assert.equal(typeof ours.Auth[k], typeof OFFICIAL.body.Auth[k], `${k} has the documented JSON type`);
  // 2, 3: numbers, RequestId preserved exactly
  assert.equal(ours.Auth.RequestId, 210601124223282);
  assert.ok(Number.isSafeInteger(ours.Auth.RequestId));
  // 4: like the official example — no Content-Type / Accept set by us; Host + Content-Length come from fetch
  assert.deepEqual(init.headers, {});
  // the official example's Content-Length is 189 with pretty-printing; ours is compact but the same JSON
  assert.ok(text.length < 189);
  assert.equal(JSON.stringify(JSON.parse(text).Auth.Sign).length - 2, OFFICIAL.body.Auth.Sign.length, "Sign is 32 hex chars like the example");
});

test("sanitized preview hides the login and the Sign, keeps structure and numbers", async () => {
  const { t } = capture();
  await t.call("CheckAuth", {});
  const preview = t.lastCall!.requestPreview!;
  assert.equal(preview, '{"Auth":{"CompanyId":9,"RequestId":210601124223282,"UserLogin":"us••••21","Sign":"<32 chars>"}}');
  assert.equal(t.lastCall!.headersSent, "нет (fetch добавит Host и Content-Length)");
  assert.doesNotMatch(preview, /[0-9a-f]{32}/);
  assert.equal(sanitizedRequestPreview('{"Auth":{"CompanyId":1,"RequestId":2,"UserLogin":"ab","Sign":"x"}}'), '{"Auth":{"CompanyId":1,"RequestId":2,"UserLogin":"••","Sign":"<1 chars>"}}');
});

test("CompanyId with quotes or spaces in the server env is rejected before sending (no CompanyId:null)", async () => {
  for (const bad of ['"108943"', "108943 ", "10 8943"]) {
    const { t, sent } = capture(bad);
    await assert.rejects(t.call("CheckAuth", {}), (e: unknown) => e instanceof KitShopConfigError);
    assert.equal(sent.length, 0, `nothing sent for ${JSON.stringify(bad)}`);
  }
});
