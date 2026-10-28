import { currentUser, handle } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { networkAnalyticsView } from "@/lib/server/networkAnalyticsView";

export const dynamic = "force-dynamic";

/** Аналитика «Все холодильники» (every role): холодильники рядом, все блюда сети с разбивкой по точкам. Read only. */
export const GET = handle(async () => {
  await currentUser();
  const rt = await getRuntime();
  await rt.ensureFreshAnalysis();
  const { snap, result } = await rt.analysis("realtime");
  return networkAnalyticsView(snap, result);
});
