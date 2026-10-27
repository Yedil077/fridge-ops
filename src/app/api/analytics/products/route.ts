import { currentUser, handle } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { productAnalyticsView } from "@/lib/server/productAnalyticsView";

export const dynamic = "force-dynamic";

/** Аналитика блюд одного холодильника (every role): продажи, снятия, наличие, норма на день, что нужно сегодня. Read only. */
export const GET = handle(async (req: Request) => {
  await currentUser();
  const rt = await getRuntime();
  await rt.ensureFreshAnalysis();
  const { snap, result } = await rt.analysis("realtime");
  return productAnalyticsView(snap, result, new URL(req.url).searchParams.get("fridge"), rt.untilTime());
});
