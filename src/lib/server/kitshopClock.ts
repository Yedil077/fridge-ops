import "server-only";
import { kitshopDate, parseKitshopDate } from "@/services/kitshop/transport";
import type { KitShopReadOnlyClient } from "@/services/kitshop/kitshopClient";
import type { KsDataset, NewSalesLog } from "../kitshop-data/dataset";
import type { HistorySource } from "../kitshop-data/history";
import { wallClockNow } from "../time";

/**
 * Диагностика времени и новых чеков на РЕАЛЬНЫХ ответах KiT Shop (only get* calls, nothing is written anywhere):
 *  1. the newest receipts of one shop as KiT Shop returns them — raw SaleDateTime, our parsed time, the difference;
 *  2. the sync's own "new receipts" request repeated as it is sent now — From/To, what came back, what is already stored;
 *  3. the last real "GetSales (новые)" of the sync (what it sent, how many written / duplicates / not written and why);
 *  4. the 3 newest receipts with their lines — to compare with the KiT Shop cabinet by hand.
 */

type Reader = Pick<KitShopReadOnlyClient, "getSales" | "getSaleById">;

const TZ = process.env.APP_TIMEZONE || "Asia/Almaty";
const fmt = (ms: number | null) => (ms === null ? null : kitshopDate(ms));

export async function clockDiagnostic(input: {
  reader: Reader;
  ds: KsDataset;
  shopId: string;
  shopName: string;
  offsetMinutes: number;
  now?: number;
  lastSalesSyncAt: number | null;
  overlapMs: number;
  /** our copy (PostgreSQL) — receipts per day to compare with what KiT Shop has */
  history?: HistorySource;
  days?: number;
}) {
  const now = input.now ?? wallClockNow(TZ);
  const off = input.offsetMinutes * 60_000;
  const toKs = (ms: number) => ms - off;
  const ds = input.ds;
  const errors: string[] = [];

  // 1. the newest receipts of this shop: ±12 h around now, in KiT Shop's clock, filtered by ShopId
  const probeFrom = toKs(now - 12 * 3_600_000);
  const probeTo = toKs(now + 12 * 3_600_000);
  let rows: Awaited<ReturnType<Reader["getSales"]>> = [];
  try {
    rows = await input.reader.getSales({ from: probeFrom, to: probeTo, shopId: input.shopId });
  } catch (e) {
    errors.push(`GetSales (последние чеки): ${(e as Error).message}`);
  }
  const parsed = rows
    .map((r) => ({ saleId: r.SaleId, shopId: r.ShopId, raw: r.SaleDateTime, rawMs: parseKitshopDate(r.SaleDateTime), sum: r.Sum ?? null }))
    .filter((r): r is typeof r & { rawMs: number } => r.rawMs !== null)
    .sort((a, b) => b.rawMs - a.rawMs);
  const newest = parsed[0] ?? null;
  const lastHour = newest ? parsed.filter((r) => r.rawMs > newest.rawMs - 3_600_000).length : 0;

  // 4. the 3 newest with their lines (GetSaleById) + what we have stored for them
  const last3 = [];
  for (const r of parsed.slice(0, 3)) {
    let lines: { productId: string; name: string; qty: number }[] = [];
    let rawDetail: string | null = null;
    try {
      const d = await input.reader.getSaleById(r.saleId);
      rawDetail = d?.SaleDateTime ?? null;
      lines = (d?.Positions ?? []).map((p) => ({ productId: p.ProductId, name: ds.products.get(p.ProductId)?.name ?? `#${p.ProductId}`, qty: p.Quantity }));
    } catch (e) {
      errors.push(`GetSaleById ${r.saleId}: ${(e as Error).message}`);
    }
    const stored = ds.sales.get(r.saleId);
    last3.push({
      saleId: r.saleId,
      shopId: r.shopId,
      raw: r.raw,
      rawFromSaleById: rawDetail,
      parsed: fmt(r.rawMs + off),
      lines,
      inKsSales: !!stored,
      storedTime: stored ? fmt(stored.soldAt) : null,
      storedLines: stored ? (ds.positions.get(r.saleId) ?? []).map((p) => ({ productId: p.productId, qty: p.qty })) : null,
    });
  }

  // 2. the sync's "new receipts" request, repeated now exactly as the sync would send it (all shops, no ShopId)
  const syncFrom = input.lastSalesSyncAt !== null ? input.lastSalesSyncAt - input.overlapMs : now - 86_400_000;
  const rq = { from: toKs(syncFrom), to: toKs(now) };
  let syncRows: Awaited<ReturnType<Reader["getSales"]>> = [];
  let syncError: string | null = null;
  try {
    syncRows = await input.reader.getSales(rq);
  } catch (e) {
    syncError = (e as Error).message;
  }
  const times = syncRows.map((r) => ({ r, t: parseKitshopDate(r.SaleDateTime) })).filter((x) => x.t !== null) as { r: (typeof syncRows)[number]; t: number }[];
  times.sort((a, b) => a.t - b.t);
  let already = 0;
  let wouldWrite = 0;
  for (const { r, t } of times) {
    const cur = ds.sales.get(r.SaleId);
    if (cur && cur.soldAt === t + off && cur.shopId === r.ShopId) already++;
    else wouldWrite++;
  }

  // 5. the last days: receipts KiT Shop has for this shop vs receipts in our copy — a difference is a DATA GAP
  const dayRows: { date: string; kitshop: number | null; ours: number | null; oursWithLines: number | null; gap: boolean; error: string | null }[] = [];
  const today = Math.floor(now / 86_400_000);
  for (let d = today - (input.days ?? 3) + 1; d <= today; d++) {
    const from = d * 86_400_000;
    const to = Math.min((d + 1) * 86_400_000, now);
    let kitshop: number | null = null;
    let ours: number | null = null;
    let oursWithLines: number | null = null;
    let error: string | null = null;
    try {
      kitshop = (await input.reader.getSales({ from: toKs(from), to: toKs(to), shopId: input.shopId })).length;
    } catch (e) {
      error = `KiT Shop: ${(e as Error).message}`;
    }
    if (input.history) {
      const h = await input.history.shopHistory(input.shopId, from, to);
      ours = h.receipts.length;
      oursWithLines = h.receipts.filter((r) => r.detailed).length;
    }
    dayRows.push({ date: fmt(from)!.slice(0, 10), kitshop, ours, oursWithLines, gap: kitshop !== null && ours !== null && ours < kitshop, error });
  }

  return {
    days: dayRows,
    shop: { shopId: input.shopId, name: input.shopName },
    nowAlmaty: fmt(now),
    offsetMinutes: input.offsetMinutes,
    newest: newest
      ? {
          saleId: newest.saleId,
          raw: newest.raw,
          parsed: fmt(newest.rawMs + off),
          ageMinutes: Math.round((now - (newest.rawMs + off)) / 60_000),
          receiptsInItsLastHour: lastHour,
          inKsSales: ds.sales.has(newest.saleId),
        }
      : null,
    probe: { fromSent: kitshopDate(probeFrom), toSent: kitshopDate(probeTo), returned: rows.length },
    syncRequestNow: {
      fromSent: kitshopDate(rq.from),
      toSent: kitshopDate(rq.to),
      returned: syncRows.length,
      minRaw: times[0]?.r.SaleDateTime ?? null,
      maxRaw: times[times.length - 1]?.r.SaleDateTime ?? null,
      alreadyInKsSales: already,
      notYetInKsSales: wouldWrite,
      unreadableDates: syncRows.length - times.length,
      error: syncError,
    },
    lastSyncRequest: (ds.state.lastNewSales ?? null) as NewSalesLog | null,
    lastSalesSyncAt: fmt(input.lastSalesSyncAt),
    last3,
    storedNewestForShop: (() => {
      let best: number | null = null;
      for (const s of ds.sales.values()) if (s.shopId === input.shopId && s.soldAt <= now + 86_400_000 && (best === null || s.soldAt > best)) best = s.soldAt;
      return fmt(best);
    })(),
    errors,
  };
}

export type ClockDiagnostic = Awaited<ReturnType<typeof clockDiagnostic>>;
