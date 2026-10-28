import { handle, requireUser } from "@/lib/server/http";
import { HttpError } from "@/lib/server/runtime";
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
  const shopId = new URL(req.url).searchParams.get("shop") ?? "621287";
  if (!/^\d{1,12}$/.test(shopId)) throw new HttpError(400, "ShopId — число");
  return clockDiagnostic({
    reader: kitshopReader(),
    ds: live.ds,
    shopId,
    shopName: live.ds.shops.get(shopId)?.name ?? shopId,
    offsetMinutes: Number(process.env.KITSHOP_TIME_OFFSET_MINUTES ?? 0) || 0,
    lastSalesSyncAt: live.ds.state.lastSalesSyncAt,
    overlapMs: live.sync.o.salesOverlapMs,
  });
});
