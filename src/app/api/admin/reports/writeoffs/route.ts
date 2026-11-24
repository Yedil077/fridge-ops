import { handle, requireUser } from "@/lib/server/http";
import { HttpError } from "@/lib/server/runtime";
import { kitshopLiveStarted } from "@/lib/server/kitshopLive";
import { fillDirection } from "@/lib/kitshop-data/fillDirection";
import { dayNumber, isoDate, wallClockNow } from "@/lib/time";

export const dynamic = "force-dynamic";

const DAY = 86_400_000;

/**
 * Списания (MANAGER+, read only): per day × fridge × dish — loaded, sold, taken out («снято»), written off — from our
 * copy of KiT Shop. ?days=N (7–120, default 35). Rows are compact arrays: [day, shopId, productId, loaded, sold, removed, writtenOff].
 * `coverage` says from which day the copy is complete (receipts with their lines) — earlier days are not comparable yet.
 */
export const GET = handle(async (req: Request) => {
  await requireUser("MANAGER");
  const live = kitshopLiveStarted();
  if (!live) throw new HttpError(409, "Только с реальными данными KiT Shop");
  await live.ready();
  const days = Math.max(7, Math.min(120, Number(new URL(req.url).searchParams.get("days")) || 35));
  const now = wallClockNow(process.env.APP_TIMEZONE || "Asia/Almaty");
  const to = (dayNumber(now) + 1) * DAY;
  const from = to - (days + 1) * DAY;
  const hist = live.repo.history(live.ds);
  const shops = [...live.ds.shops.values()];
  const agg = new Map<string, number[]>();
  const add = (d: number, shopId: string, productId: string, i: number, q: number) => {
    const k = `${d}|${shopId}|${productId}`;
    const a = agg.get(k) ?? [0, 0, 0, 0];
    a[i] += q;
    agg.set(k, a);
  };
  const receipts: Record<string, Record<string, [number, number]>> = {};
  for (const s of shops) {
    const h = await hist.shopHistory(s.shopId, from, to);
    for (const x of h.sales) add(dayNumber(x.at), s.shopId, x.productId, 1, x.qty);
    for (const f of h.fills) {
      const d = fillDirection(f.type, f.qty);
      add(dayNumber(f.at), s.shopId, f.productId, d.kind === "load" ? 0 : d.kind === "unload" ? 2 : 3, Math.abs(d.delta));
    }
    const r = (receipts[s.shopId] = {} as Record<string, [number, number]>);
    for (const x of h.receipts) {
      const k = isoDate(dayNumber(x.at));
      const v = (r[k] ??= [0, 0]);
      v[0]++;
      if (x.detailed) v[1]++;
    }
  }
  const rows = [...agg].map(([k, a]) => {
    const [d, shopId, productId] = k.split("|");
    return [isoDate(Number(d)), shopId, productId, ...a.map((x) => Math.round(x * 100) / 100)];
  });
  const used = new Set(rows.map((r) => r[2] as string));
  return {
    from: isoDate(dayNumber(from)),
    to: isoDate(dayNumber(to) - 1),
    shops: Object.fromEntries(shops.map((s) => [s.shopId, s.name])),
    products: Object.fromEntries([...live.ds.products.values()].filter((p) => used.has(p.productId)).map((p) => [p.productId, { name: p.name, groupId: p.groupId }])),
    groups: Object.fromEntries([...live.ds.groups.values()].map((g) => [g.groupId, g.name])),
    /** shopId → day → [receipts, receipts with lines] */
    receipts,
    rows,
  };
});
