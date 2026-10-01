import { test } from "node:test";
import assert from "node:assert/strict";
import { DryRunWriteAdapter, MockWriteAdapter } from "../src/lib/kitshop-ops/adapters";
import { OpsService, OpsError, type OpsState, type SubmitInput } from "../src/lib/kitshop-ops/service";
import type { KitShopWriteAdapter, KsOperation } from "../src/lib/kitshop-ops/types";

/** Scenario tests for KiT Shop writes against the mock / dry-run adapters (spec §38). No network. */

function setup(opts: { adapter?: KitShopWriteAdapter; timeoutMs?: number; trust?: boolean } = {}) {
  const adapter = opts.adapter ?? new MockWriteAdapter();
  const state: OpsState = { operations: [], audit: [] };
  let clock = 1_000_000;
  let seq = 0;
  const confirmed: KsOperation[] = [];
  const ops = new OpsService({
    state,
    adapterFor: () => adapter,
    now: () => clock,
    save: () => undefined,
    newId: (p) => `${p}${++seq}`,
    timeoutMs: opts.timeoutMs ?? 200,
    trustAbsent: () => opts.trust ?? true,
    verifyWindowMs: 60_000,
    onConfirmed: (op) => confirmed.push(op),
  });
  return { ops, state, adapter, confirmed, tick: (ms: number) => (clock += ms) };
}

const line = (productId: string, qty: number, ks = `9${productId}`) => ({ productId, kitshopProductId: ks, name: productId, qty });
const load = (id: string, lines = [line("p1", 3)]): SubmitInput => ({ id, type: "LOAD", fridgeId: "F05", shopId: "621583", fridgeName: "Сатти 1", lines });

test("load success → CONFIRMED, signed quantity, marker in Notes", async () => {
  const { ops, adapter, confirmed } = setup();
  const { op } = await ops.submit(load("op-00000001"), "Айгерим");
  assert.equal(op.status, "CONFIRMED");
  assert.equal(confirmed.length, 1);
  const sent = (adapter as MockWriteAdapter).ledger.get("op-00000001")!;
  assert.equal(sent.lines[0].fillup, 3);
  assert.match(sent.notes, /^FO:op-00000001 LOAD/);
});

test("unload and write-off are sent with negative quantities; write-off needs a reason", async () => {
  const { ops, adapter } = setup();
  await ops.submit({ ...load("op-unload-1"), type: "UNLOAD" }, "u");
  assert.equal((adapter as MockWriteAdapter).ledger.get("op-unload-1")!.lines[0].fillup, -3);
  await assert.rejects(ops.submit({ ...load("op-wo-0001"), type: "WRITE_OFF" }, "u"), /причину/);
  const { op } = await ops.submit({ ...load("op-wo-0002"), type: "WRITE_OFF", reason: "истёк срок" }, "u");
  assert.equal(op.status, "CONFIRMED");
  assert.equal((adapter as MockWriteAdapter).ledger.get("op-wo-0002")!.lines[0].fillup, -3);
});

test("partial quantities: only the actual numbers are sent, zero lines dropped", async () => {
  const { ops, adapter } = setup();
  await ops.submit(load("op-partial1", [line("p1", 2), line("p2", 0)]), "u");
  assert.deepEqual((adapter as MockWriteAdapter).ledger.get("op-partial1")!.lines, [{ kitshopProductId: "9p1", fillup: 2 }]);
});

test("duplicate click / offline re-send with the same uuid is never sent twice", async () => {
  const { ops, adapter } = setup();
  const [a, b] = await Promise.all([ops.submit(load("op-dup-0001"), "u"), ops.submit(load("op-dup-0001"), "u")]);
  assert.equal((adapter as MockWriteAdapter).calls, 1);
  assert.equal(a.op, b.op);
  assert.ok(a.duplicate !== b.duplicate);
  const again = await ops.submit(load("op-dup-0001"), "u");
  assert.equal(again.duplicate, true);
  assert.equal((adapter as MockWriteAdapter).calls, 1);
});

test("timeout → UNKNOWN, retry refused, verification finds nothing → FAILED, then manual re-send", async () => {
  const mock = new MockWriteAdapter();
  mock.script.push("timeout");
  const { ops, tick } = setup({ adapter: mock });
  const { op } = await ops.submit(load("op-timeout1"), "u");
  assert.equal(op.status, "UNKNOWN");
  await assert.rejects(ops.retry(op.id, "u"), (e: unknown) => e instanceof OpsError && e.status === 409);
  await ops.verify(op.id, "u");
  assert.equal(op.status, "UNKNOWN", "inside the window an absent op may still appear");
  tick(120_000);
  await ops.verify(op.id, "u");
  assert.equal(op.status, "FAILED");
  await ops.retry(op.id, "manager");
  assert.equal(op.status, "CONFIRMED");
  assert.equal(op.attempts, 2);
});

test("slow KiT Shop beyond the timeout → UNKNOWN, a late OK still confirms it", async () => {
  const mock = new MockWriteAdapter(60);
  const { ops } = setup({ adapter: mock, timeoutMs: 20 });
  const { op } = await ops.submit(load("op-slow-0001"), "u");
  assert.equal(op.status, "UNKNOWN");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(op.status, "CONFIRMED");
});

test("lost response → UNKNOWN, verification finds it → CONFIRMED without a second write", async () => {
  const mock = new MockWriteAdapter();
  mock.script.push("lost");
  const { ops } = setup({ adapter: mock });
  const { op } = await ops.submit(load("op-lost-0001"), "u");
  assert.equal(op.status, "UNKNOWN");
  await ops.verify(op.id, "u");
  assert.equal(op.status, "CONFIRMED");
  assert.equal(mock.calls, 1);
});

test("live adapter before Phase D: absent → REQUIRES_REVIEW, manager decides", async () => {
  const mock = new MockWriteAdapter();
  mock.script.push("timeout");
  const { ops } = setup({ adapter: mock, trust: false });
  const { op } = await ops.submit(load("op-review-01"), "u");
  await ops.verify(op.id, "u");
  assert.equal(op.status, "REQUIRES_REVIEW");
  ops.resolve(op.id, "failed", "manager", "в кабинете нет");
  assert.equal(op.status, "FAILED");
});

test("offline (KiT Shop unreachable) → WAITING_FOR_CONNECTION, sent exactly once later", async () => {
  const mock = new MockWriteAdapter();
  mock.script.push("unreachable");
  const { ops } = setup({ adapter: mock });
  const { op } = await ops.submit(load("op-offline-1"), "u");
  assert.equal(op.status, "WAITING_FOR_CONNECTION");
  assert.equal(op.attempts, 0);
  await ops.tick();
  assert.equal(op.status, "CONFIRMED");
  await ops.tick();
  assert.equal(mock.ledger.size, 1);
  assert.equal(op.attempts, 1);
});

test("wrong / missing mapping → MAPPING_REQUIRED, nothing sent", async () => {
  const { ops, adapter, state } = setup();
  await assert.rejects(ops.submit(load("op-map-0001", [line("p1", 2, "")]), "u"), (e: unknown) => e instanceof OpsError && e.code === "MAPPING_REQUIRED");
  assert.equal((adapter as MockWriteAdapter).calls, 0);
  assert.equal(state.operations.length, 0);
});

test("product missing in the shop base → FAILED NOT_IN_SHOP_BASE", async () => {
  const mock = new MockWriteAdapter();
  mock.shopBase = new Map([["621583", new Set(["9p1"])]]);
  const { ops } = setup({ adapter: mock });
  const { op } = await ops.submit(load("op-base-0001", [line("p2", 1)]), "u");
  assert.equal(op.status, "FAILED");
  assert.equal(op.errorCode, "NOT_IN_SHOP_BASE");
});

test("KiT Shop error → FAILED with the message, success never shown", async () => {
  const mock = new MockWriteAdapter();
  mock.script.push("reject");
  const { ops, confirmed } = setup({ adapter: mock });
  const { op } = await ops.submit(load("op-error-001"), "u");
  assert.equal(op.status, "FAILED");
  assert.equal(op.errorCode, "KITSHOP_ERROR");
  assert.equal(confirmed.length, 0);
});

test("transfer: unload OK + load fails → PARTIAL; retry only the load; completing twice doesn't double", async () => {
  const mock = new MockWriteAdapter();
  const { ops } = setup({ adapter: mock });
  mock.script.push("ok", "reject");
  const t = {
    missionId: "M42",
    source: { fridgeId: "F05", shopId: "621583", fridgeName: "Сатти 1" },
    targets: [{ fridgeId: "F07", shopId: "621586", fridgeName: "Сатти 4", lines: [line("p1", 2), line("p2", 1)] }],
  };
  const legs = await ops.transfer(t, "u");
  assert.equal(legs[0].status, "CONFIRMED");
  assert.equal(legs[1].status, "FAILED");
  assert.equal(ops.transferState("M42"), "PARTIAL");
  await ops.retry(legs[1].id, "manager");
  assert.equal(ops.transferState("M42"), "CONFIRMED");
  await ops.transfer(t, "u");
  assert.equal(mock.calls, 3);
});

test("transfer: the load waits while the unload is UNKNOWN and follows its verification", async () => {
  const mock = new MockWriteAdapter();
  mock.script.push("lost");
  const { ops } = setup({ adapter: mock });
  const legs = await ops.transfer(
    {
      missionId: "M43",
      source: { fridgeId: "F05", shopId: "621583", fridgeName: "Сатти 1" },
      targets: [{ fridgeId: "F06", shopId: "621826", fridgeName: "Сатти 2", lines: [line("p1", 2)] }],
    },
    "u",
  );
  assert.equal(legs[0].status, "UNKNOWN");
  assert.equal(legs[1].status, "DRAFT");
  assert.equal(legs[1].errorCode, "SOURCE_NOT_CONFIRMED");
  await ops.verify(legs[0].id, "u");
  assert.equal(legs[1].status, "CONFIRMED");
});

test("dry-run logs the exact MakeFillUp body and sends nothing", async () => {
  const lines: string[] = [];
  const dry = new DryRunWriteAdapter((l) => lines.push(l));
  const { ops } = setup({ adapter: dry });
  const { op } = await ops.submit({ ...load("op-dryrun-01", [line("p1", 3, "810005")]), type: "UNLOAD" }, "u");
  assert.equal(op.adapterMode, "dry-run");
  const body = dry.sent[0].body as { ShopId: number; Notes: string; FillUps: unknown[] };
  assert.equal(dry.sent[0].method, "MakeFillUp");
  assert.equal(body.ShopId, 621583);
  assert.match(body.Notes, /^FO:op-dryrun-01 UNLOAD/);
  assert.deepEqual(body.FillUps, [{ ProductId: 810005, Fillup: -3 }]);
  assert.ok(lines[0].startsWith("[kitshop:dry-run] WOULD POST MakeFillUp"));
  assert.doesNotMatch(lines[0], /Sign|Password|Auth/);
});

test("every write is in the audit log", async () => {
  const { ops, state } = setup();
  await ops.submit(load("op-audit-001"), "Айгерим");
  const actions = state.audit.map((a) => a.action);
  assert.deepEqual(actions, ["op.create", "op.result"]);
  assert.equal(state.audit[0].user, "Айгерим");
});
