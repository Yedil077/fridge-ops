import "server-only";
import { catalogHealth } from "../kitshop-ops/mapping";
import { OP_STATUS_LABEL, OP_TYPE_LABEL, OPEN_STATUSES, type KsOperation } from "../kitshop-ops/types";
import type { Runtime } from "./runtime";
import { writeModeSummary } from "./kitshopWrite";

/** View models for the KiT Shop operations screens. Never contains credentials. */

export function opView(op: KsOperation) {
  return {
    id: op.id,
    type: op.type,
    typeLabel: OP_TYPE_LABEL[op.type],
    status: op.status,
    statusLabel: OP_STATUS_LABEL[op.status],
    fridgeId: op.fridgeId,
    fridgeName: op.fridgeName,
    shopId: op.shopId,
    lines: op.lines.map((l) => ({ productId: l.productId, name: l.name, qty: l.qty, kitshopProductId: l.kitshopProductId })),
    units: op.lines.reduce((a, l) => a + l.qty, 0),
    reason: op.reason,
    errorCode: op.errorCode,
    error: op.error,
    createdAt: op.createdAt,
    createdBy: op.createdBy,
    sentAt: op.sentAt,
    confirmedAt: op.confirmedAt,
    attempts: op.attempts,
    adapterMode: op.adapterMode,
    missionId: op.missionId,
    transferRole: op.transferRole,
    kitshopFillupId: op.kitshopFillupId,
    history: op.history.slice(-8),
  };
}

export type OpView = ReturnType<typeof opView>;

export function opsList(rt: Runtime, ops: KsOperation[], now = Date.now()) {
  const all = rt.state.operations;
  return {
    operations: ops.map(opView),
    counts: {
      open: all.filter((o) => OPEN_STATUSES.includes(o.status)).length,
      unknown: all.filter((o) => o.status === "UNKNOWN" || o.status === "REQUIRES_REVIEW").length,
      waiting: all.filter((o) => o.status === "WAITING_FOR_CONNECTION").length,
      failed: all.filter((o) => o.status === "FAILED" && now - o.createdAt < 86_400_000).length,
    },
    write: writeModeSummary(),
  };
}

/** Everything the scan / load screen needs for one fridge in one request (filtered on the phone). */
export async function opsCatalog(rt: Runtime, fridgeId: string) {
  const snap = await rt.snapshot();
  const f = snap.fridges.findIndex((x) => x.id === fridgeId);
  const P = snap.products.length;
  const catalog = rt.catalog(snap);
  return {
    now: snap.now,
    fridge: f >= 0 ? { id: snap.fridges[f].id, name: snap.fridges[f].name, shopId: snap.fridges[f].externalId } : null,
    /** stock comes from the live data source; in MOCK mode it is always current */
    stockSyncedAt: snap.now,
    write: writeModeSummary(),
    products: snap.products
      .map((p, i) => {
        const m = rt.mappingFor(snap, p.id, catalog);
        return {
          id: p.id,
          name: p.name,
          sku: p.sku,
          barcode: p.barcode,
          categoryId: p.categoryId,
          stock: f >= 0 ? snap.stock[f * P + i] : 0,
          mapped: m.status === "MAPPED",
          kitshopProductId: m.status === "MAPPED" ? m.kitshopProductId : null,
          inactive: !!rt.state.productMappings[p.id]?.inactive,
        };
      })
      .filter((p) => !p.inactive),
  };
}

/** Admin products screen: mapping status, suggestions and catalog health. */
export async function productsAdmin(rt: Runtime) {
  const snap = await rt.snapshot();
  const catalog = rt.catalog(snap);
  const local = snap.products.map((p) => ({ id: p.id, name: p.name, barcode: p.barcode, sku: p.sku }));
  return {
    source: rt.mode,
    catalogSize: catalog.length,
    health: catalogHealth(local, catalog, rt.state.productMappings),
    write: writeModeSummary(),
    products: snap.products.map((p) => {
      const m = rt.mappingFor(snap, p.id, catalog);
      const conf = rt.state.productMappings[p.id];
      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        barcode: p.barcode,
        price: p.price,
        categoryId: p.categoryId,
        status: m.status,
        kitshopProductId: m.status === "MAPPED" ? m.kitshopProductId : null,
        matchedBy: m.status === "MAPPED" ? m.matchedBy : null,
        reason: m.status === "MAPPING_REQUIRED" ? m.reason : null,
        suggestions: m.status === "MAPPING_REQUIRED" ? m.suggestions : [],
        inactive: !!conf?.inactive,
        confirmedBy: conf?.confirmedBy ?? null,
      };
    }),
  };
}
