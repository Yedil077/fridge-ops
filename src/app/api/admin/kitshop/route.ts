import { z } from "zod";
import { handle, requireUser } from "@/lib/server/http";
import { getRuntime, HttpError } from "@/lib/server/runtime";
import { adminState, checkConnection, diagnostics, ourFridges, runRealApiTest, testProductCandidates, writeTest } from "@/lib/server/kitshopAdmin";

export const dynamic = "force-dynamic";

/** KiT Shop diagnostics (ADMIN). No credentials are ever returned. */
export const GET = handle(async () => {
  await requireUser("ADMIN");
  return diagnostics(await getRuntime());
});

const Kind = z.enum(["LOAD", "UNLOAD"]);
const Body = z.discriminatedUnion("action", [
  /** read-only CheckAuth + GetShops */
  z.object({ action: z.literal("check") }),
  /** REAL API TEST: HTTPS → AUTH → SHOPS → STOCKS → SALES, read-only, never mock */
  z.object({ action: z.literal("real-test") }),
  /** only DNS/HTTPS + CheckAuth */
  z.object({ action: z.literal("real-test-auth") }),
  /** server-side PAUSE ALL WRITES flag (env variables are never changed from here) */
  z.object({ action: z.literal("pause"), on: z.boolean() }),
  z.object({ action: z.literal("set-test-shop"), shopId: z.string().regex(/^\d{1,12}$/) }),
  z.object({ action: z.literal("products"), q: z.string().max(80).default("") }),
  z.object({ action: z.literal("set-test-product"), productId: z.string().regex(/^\d{1,18}$/), name: z.string().min(1).max(200), barcode: z.string().max(60).nullable() }),
  z.object({ action: z.literal("test-start") }),
  z.object({ action: z.literal("test-check") }),
  z.object({ action: z.literal("test-prepare"), kind: Kind }),
  /** the ONLY action that writes to KiT Shop: one prepared ±1 operation, by its uuid */
  z.object({ action: z.literal("test-confirm"), kind: Kind, opId: z.string().uuid() }),
  z.object({ action: z.literal("test-evaluate"), kind: Kind }),
]);

export const POST = handle(async (req: Request) => {
  const admin = await requireUser("ADMIN");
  const body = Body.parse(await req.json());
  const rt = await getRuntime();
  const st = adminState(rt);
  const busy = () => {
    const r = st.writeTest;
    return !!r && !r.finishedAt && [r.load, r.unload].some((l) => l?.sentAt && l.result !== "PASS" && l.result !== "FAIL");
  };
  switch (body.action) {
    case "check":
      return checkConnection(rt, admin.name);
    case "real-test":
      return { report: await runRealApiTest(rt, admin.name) };
    case "real-test-auth":
      return { report: await runRealApiTest(rt, admin.name, true) };
    case "pause":
      st.writesPaused = body.on;
      st.pausedBy = body.on ? admin.name : null;
      st.pausedAt = body.on ? Date.now() : null;
      rt.ops.audit(admin.name, body.on ? "kitshop.writes_paused" : "kitshop.writes_resumed", "kitshop", "writes", {});
      rt.save();
      return { paused: st.writesPaused };
    case "set-test-shop": {
      if (busy()) throw new HttpError(409, "Идёт тест с отправленной операцией — сначала завершите проверку");
      const f = (await ourFridges(rt)).find((x) => x.shopId === body.shopId);
      if (!f) throw new HttpError(422, "Такой ShopId не привязан ни к одному холодильнику Fridge Ops");
      st.testShop = { shopId: body.shopId, name: f.name, fridgeId: f.id, setBy: admin.name, at: Date.now() };
      if (st.testProduct) st.testProduct = null; // product stock belongs to the shop — choose again
      rt.ops.audit(admin.name, "kitshop.test_shop", "kitshop", body.shopId, { name: f.name });
      rt.save();
      return { testShop: st.testShop };
    }
    case "products":
      return testProductCandidates(rt, body.q);
    case "set-test-product":
      if (busy()) throw new HttpError(409, "Идёт тест с отправленной операцией — сначала завершите проверку");
      if (!st.testShop) throw new HttpError(400, "Сначала выберите TEST SHOP");
      st.testProduct = { productId: body.productId, name: body.name, barcode: body.barcode, setBy: admin.name, at: Date.now() };
      rt.ops.audit(admin.name, "kitshop.test_product", "kitshop", body.productId, { name: body.name, shopId: st.testShop.shopId });
      rt.save();
      return { testProduct: st.testProduct };
    case "test-start":
      return { run: writeTest(rt).start(admin.name) };
    case "test-check":
      return { run: await writeTest(rt).checkConnection() };
    case "test-prepare":
      return { run: await writeTest(rt).prepare(body.kind, admin.name) };
    case "test-confirm":
      return { run: await writeTest(rt).confirm(body.kind, body.opId, admin.name) };
    case "test-evaluate":
      return { run: await writeTest(rt).evaluate(body.kind, admin.name) };
  }
});
