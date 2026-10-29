import { handle, requireUser } from "@/lib/server/http";
import { z } from "zod";
import { getRuntime, HttpError } from "@/lib/server/runtime";
import { kitshopLiveStarted } from "@/lib/server/kitshopLive";
import { kitshopReader } from "@/lib/server/kitshopWrite";
import { clockDiagnostic } from "@/lib/server/kitshopClock";

export const dynamic = "force-dynamic";

/** Диагностика времени KiT Shop и новых чеков на реальных ответах (ADMIN). Только get*-запросы, ничего не пишет. */
export const GET = handle(async (req: Request) => {
  await requireUser("ADMIN");
  const live = kitshopLiveStarted();
  if (!live) throw new HttpError(409, "Диагностика доступна только при DATA_SOURCE=kitshop");
  await live.ready();
  const url = new URL(req.url);
  const shopId = url.searchParams.get("shop") ?? "621287";
  const days = Math.min(31, Math.max(1, Number(url.searchParams.get("days") ?? 3) || 3));
  if (!/^\d{1,12}$/.test(shopId)) throw new HttpError(400, "ShopId — число");
  return clockDiagnostic({
    reader: kitshopReader(),
    ds: live.ds,
    shopId,
    shopName: live.ds.shops.get(shopId)?.name ?? shopId,
    offsetMinutes: Number(process.env.KITSHOP_TIME_OFFSET_MINUTES ?? 0) || 0,
    lastSalesSyncAt: live.ds.state.lastSalesSyncAt,
    overlapMs: live.sync.o.salesOverlapMs,
    history: live.repo.history(live.ds),
    days,
  });
});

const Reread = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/**
 * Re-read whole days from KiT Shop (ADMIN, only get* requests): receipts and loads of those days that our copy missed
 * (e.g. while the time offset was wrong). Duplicates are never stored twice; the nightly analytics runs again after it.
 */
export const POST = handle(async (req: Request) => {
  const admin = await requireUser("ADMIN");
  const live = kitshopLiveStarted();
  if (!live) throw new HttpError(409, "Только при DATA_SOURCE=kitshop");
  await live.ready();
  const b = Reread.parse(await req.json());
  const DAY = 86_400_000;
  const from = Math.floor(Date.parse(`${b.from}T00:00:00Z`) / DAY);
  const to = Math.floor(Date.parse(`${b.to}T00:00:00Z`) / DAY);
  if (to < from || to - from > 40) throw new HttpError(400, "Не больше 40 дней за раз");
  const days: { date: string; receipts: number; fillUps: number }[] = [];
  for (let d = from; d <= to; d++) days.push({ date: new Date(d * DAY).toISOString().slice(0, 10), ...(await live.sync.rereadDay(d * DAY)) });
  (await getRuntime()).ops.audit(admin.name, "kitshop.reread", "kitshop", `${b.from}..${b.to}`, { days });
  void live.runAnalyticsNow("перечитаны дни");
  return { days };
});
