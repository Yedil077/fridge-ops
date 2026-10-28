import { currentUser, handle } from "@/lib/server/http";
import { HttpError } from "@/lib/server/runtime";
import { kitshopLiveStarted } from "@/lib/server/kitshopLive";
import { menuCatalog } from "@/lib/server/tomorrowView";

export const dynamic = "force-dynamic";

/** Dishes of the KiT Shop catalog that can be put on the menu. */
export const GET = handle(async () => {
  await currentUser();
  const live = kitshopLiveStarted();
  if (!live) throw new HttpError(409, "Только с реальными данными KiT Shop");
  await live.ready();
  return { products: menuCatalog(live) };
});
