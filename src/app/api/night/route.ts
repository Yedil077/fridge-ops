import { currentUser, handle } from "@/lib/server/http";
import { getRuntime, HttpError } from "@/lib/server/runtime";
import { kitshopLiveStarted } from "@/lib/server/kitshopLive";
import { nightView } from "@/lib/server/nightView";

export const dynamic = "force-dynamic";

/** НОЧЬ (every role — the driver sees the route): what to take, write off, move and put in every fridge. Read only towards KiT Shop. */
export const GET = handle(async (req: Request) => {
  await currentUser();
  const live = kitshopLiveStarted();
  if (!live) throw new HttpError(409, "Ночное задание работает только с реальными данными KiT Shop");
  await live.ready();
  const rt = await getRuntime();
  const { snap } = await rt.analysis("realtime");
  return nightView(live, snap, rt.shelfLife(), new URL(req.url).searchParams.get("date"));
});
