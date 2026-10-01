import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MockWriteAdapter } from "../src/lib/kitshop-ops/adapters";
import { OpsService, type OpsState } from "../src/lib/kitshop-ops/service";
import { summarize, WriteTest, type KitShopAdminState } from "../src/lib/kitshop-ops/writeTest";
import type { KitShopWriteAdapter, KsOperation } from "../src/lib/kitshop-ops/types";

/** PHASE D wizard against a fake KiT Shop whose stock follows the applied fill-ups. No network. */

const SHOP = "621583";
const PRODUCT = "810007";

/** mock adapter pretending to be "live" (so the live rules apply: absent UUID → REQUIRES_REVIEW) */
class FakeLive extends MockWriteAdapter {
  override readonly mode = "mock" as const;
  constructor() {
    super(0);
  }
}

function setup(opts: { base?: number; sale?: number; live?: boolean; blocked?: string | null } = {}) {
  const kit = new FakeLive();
  const liveLike: KitShopWriteAdapter = opts.live ? Object.assign(Object.create(kit), { mode: "live" }) : kit;
  const ops: OpsState = { operations: [], audit: [] };
  const order: string[] = [];
  const service = new OpsService({
    state: ops,
    adapterFor: () => liveLike,
    now: () => Date.now(),
    save: () => undefined,
    flush: async () => void order.push("flush"),
    newId: (p) => `${p}${Math.random()}`,
    timeoutMs: 200,
    trustAbsent: (mode) => mode !== "live",
    verifyWindowMs: 0,
  });
  const origMake = kit.makeFillUp.bind(kit);
  kit.makeFillUp = async (req) => {
    order.push("send");
    return origMake(req);
  };
  let extraSale = opts.sale ?? 0;
  const admin: KitShopAdminState = {
    writesPaused: false,
    pausedBy: null,
    pausedAt: null,
    testShop: { shopId: SHOP, name: "5 БЦ Сатти 1 этаж", fridgeId: "F05", setBy: "admin", at: 0 },
    testProduct: { productId: PRODUCT, name: "Паста с говядиной", barcode: "4600000000007", setBy: "admin", at: 0 },
    writeTest: null,
  };
  const readStock = async () => {
    let q = opts.base ?? 7;
    for (const e of kit.ledger.values()) for (const l of e.lines) if (e.shopId === SHOP && l.kitshopProductId === PRODUCT) q += l.fillup;
    q -= extraSale;
    extraSale = 0; // a sale happens once
    return q;
  };
  const wt = new WriteTest({
    state: admin,
    now: () => Date.now(),
    newId: () => randomUUID(),
    checkAuth: async () => ({ ok: true, ms: 120, detail: "CheckAuth: ResultCode 0" }),
    readStock,
    liveBlocked: () => opts.blocked ?? null,
    isPaused: () => admin.writesPaused,
    submit: (i, u) => service.submit(i, u),
    verify: (id, u) => service.verify(id, u),
    getOp: (id) => service.get(id),
    findInFillUps: (op: KsOperation) => kit.verifyFillUp({ id: op.id }),
    auditFor: (id) => ops.audit.filter((a) => a.entityId === id),
    save: () => undefined,
  });
  return { wt, kit, admin, ops, order };
}

async function fullRun(wt: WriteTest) {
  wt.start("admin");
  await wt.checkConnection();
  let r = await wt.prepare("LOAD", "admin");
  r = await wt.confirm("LOAD", r.load!.opId, "admin");
  r = await wt.prepare("UNLOAD", "admin");
  return wt.confirm("UNLOAD", r.unload!.opId, "admin");
}

test("happy path: 7 → +1 → 8 → −1 → 7, all PASS, READY", async () => {
  const { wt, kit } = setup();
  const r = await fullRun(wt);
  assert.deepEqual([r.load!.before, r.load!.expected, r.load!.actual], [7, 8, 8]);
  assert.deepEqual([r.unload!.before, r.unload!.expected, r.unload!.actual], [8, 7, 7]);
  assert.equal(kit.calls, 2, "exactly two writes reached KiT Shop");
  const s = summarize(r);
  assert.ok(s.ready, JSON.stringify(s.lines));
  assert.match(r.load!.notes, new RegExp(`^FO:${r.load!.opId} LOAD WRITE-TEST by admin$`));
});

test("preparing sends nothing; unload only after a passed load", async () => {
  const { wt, kit } = setup();
  wt.start("admin");
  await assert.rejects(wt.prepare("LOAD", "admin"), /подключения/);
  await wt.checkConnection();
  await wt.prepare("LOAD", "admin");
  assert.equal(kit.calls, 0);
  await assert.rejects(wt.prepare("UNLOAD", "admin"), /после успешной загрузки/);
});

test("KiT Shop success alone is not enough: a stock mismatch → REQUIRES_REVIEW, NOT READY", async () => {
  const { wt } = setup({ sale: 1 });
  wt.start("admin");
  await wt.checkConnection();
  const p = await wt.prepare("LOAD", "admin");
  const r = await wt.confirm("LOAD", p.load!.opId, "admin");
  assert.equal(r.load!.opStatus, "CONFIRMED");
  assert.equal(r.load!.result, "REQUIRES_REVIEW");
  assert.equal(summarize(r).ready, false);
});

test("repeated confirm click never sends twice; duplicate protection PASS", async () => {
  const { wt, kit } = setup();
  wt.start("admin");
  await wt.checkConnection();
  const p = await wt.prepare("LOAD", "admin");
  await wt.confirm("LOAD", p.load!.opId, "admin");
  const r = await wt.confirm("LOAD", p.load!.opId, "admin");
  assert.equal(kit.calls, 1);
  assert.equal(r.duplicate!.result, "PASS");
  await assert.rejects(wt.prepare("LOAD", "admin"), /уже отправлена/);
});

test("live lost answer: no re-send; UUID found in GetFillUps → CONFIRMED → stock checked → PASS", async () => {
  const { wt, kit } = setup({ live: true });
  kit.script.push("lost");
  wt.start("admin");
  await wt.checkConnection();
  const p = await wt.prepare("LOAD", "admin");
  const r = await wt.confirm("LOAD", p.load!.opId, "admin");
  assert.equal(kit.calls, 1);
  assert.equal(r.load!.opStatus, "CONFIRMED");
  assert.equal(r.load!.fillUpsMatch, "FOUND");
  assert.equal(r.load!.result, "PASS");
});

test("live timeout and UUID absent in GetFillUps → REQUIRES_REVIEW, never re-sent", async () => {
  const { wt, kit } = setup({ live: true });
  kit.script.push("timeout");
  wt.start("admin");
  await wt.checkConnection();
  const p = await wt.prepare("LOAD", "admin");
  let r = await wt.confirm("LOAD", p.load!.opId, "admin");
  assert.equal(r.load!.opStatus, "REQUIRES_REVIEW");
  assert.equal(r.load!.result, "REQUIRES_REVIEW");
  r = await wt.evaluate("LOAD", "admin");
  assert.equal(kit.calls, 1, "re-checking only reads");
  assert.throws(() => wt.start("admin"), /не завершён/);
});

test("live send is persisted before it leaves the server", async () => {
  const { wt, order } = setup({ live: true });
  wt.start("admin");
  await wt.checkConnection();
  const p = await wt.prepare("LOAD", "admin");
  await wt.confirm("LOAD", p.load!.opId, "admin");
  assert.deepEqual(order.slice(0, 2), ["flush", "send"]);
});

test("PAUSE ALL WRITES and a closed server gate block the send", async () => {
  const paused = setup();
  paused.wt.start("admin");
  await paused.wt.checkConnection();
  const p = await paused.wt.prepare("LOAD", "admin");
  paused.admin.writesPaused = true;
  await assert.rejects(paused.wt.confirm("LOAD", p.load!.opId, "admin"), /приостановлена/);
  assert.equal(paused.kit.calls, 0);

  const closed = setup({ blocked: "ShopId 621583 не указан в KITSHOP_WRITE_SHOPS" });
  closed.wt.start("admin");
  await closed.wt.checkConnection();
  const q = await closed.wt.prepare("LOAD", "admin");
  await assert.rejects(closed.wt.confirm("LOAD", q.load!.opId, "admin"), /KITSHOP_WRITE_SHOPS/);
  assert.equal(closed.kit.calls, 0);
});

test("paused ops service refuses every write and does not auto-send waiting ones", async () => {
  const kit = new MockWriteAdapter();
  let paused = false;
  const state: OpsState = { operations: [], audit: [] };
  const svc = new OpsService({ state, adapterFor: () => kit, isPaused: () => paused, now: () => Date.now(), save: () => undefined, newId: (p) => p + Math.random(), timeoutMs: 100, trustAbsent: () => true, verifyWindowMs: 0 });
  kit.script.push("unreachable");
  const line = { productId: "p", kitshopProductId: "1", name: "p", qty: 1 };
  const { op } = await svc.submit({ id: "op-wait-0001", type: "LOAD", fridgeId: "F", shopId: "1", fridgeName: "F", lines: [line] }, "u");
  assert.equal(op.status, "WAITING_FOR_CONNECTION");
  paused = true;
  await assert.rejects(svc.submit({ id: "op-paused-01", type: "UNLOAD", fridgeId: "F", shopId: "1", fridgeName: "F", lines: [line] }, "u"), /приостановлена/);
  await svc.tick();
  assert.equal(op.status, "WAITING_FOR_CONNECTION");
  assert.equal(kit.calls, 1);
  paused = false;
  await svc.tick();
  assert.equal(op.status, "CONFIRMED");
});
