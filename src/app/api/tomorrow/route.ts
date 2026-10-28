import { currentUser, handle } from "@/lib/server/http";
import { getRuntime, HttpError } from "@/lib/server/runtime";
import { kitshopLiveStarted } from "@/lib/server/kitshopLive";
import { tomorrowView } from "@/lib/server/tomorrowView";

export const dynamic = "force-dynamic";

/** ЗАВТРА (every role): menu × fridges → how many to put. Read only towards KiT Shop. */
export const GET = handle(async (req: Request) => {
  await currentUser();
  const live = kitshopLiveStarted();
  if (!live) throw new HttpError(409, "Раздел «Завтра» работает только с реальными данными KiT Shop");
  await live.ready();
  const rt = await getRuntime();
  const { snap, result } = await rt.analysis("realtime");
  return tomorrowView(live, snap, result, new URL(req.url).searchParams.get("date"));
});
