import { currentUser, handle } from "@/lib/server/http";
import { getRuntime, HttpError } from "@/lib/server/runtime";
import { kitshopLiveStarted } from "@/lib/server/kitshopLive";
import { compareWithSheet } from "@/lib/server/sheetCompare";

export const dynamic = "force-dynamic";

/** Сверка KiT Shop ↔ Google Sheets для одного холодильника (30 полных дней). Только чтение обоих источников. */
export const GET = handle(async (req: Request) => {
  await currentUser();
  const live = kitshopLiveStarted();
  if (!live) throw new HttpError(409, "Сверка доступна только с реальными данными KiT Shop");
  await live.ready();
  const rt = await getRuntime();
  const snap = await rt.snapshot();
  const id = new URL(req.url).searchParams.get("fridge");
  const fr = snap.fridges.find((f) => f.id === id) ?? snap.fridges[0];
  return { fridge: fr.name, ...(await compareWithSheet(live.ds, fr.externalId, snap.now)) };
});
