import { currentUser, handle } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { mobileAnalytics } from "@/lib/server/mobile";
import { modeFrom } from "@/lib/server/mode";

export const dynamic = "force-dynamic";

/** Аналитика tab (every role): today's sales, last hour, 1–2 h forecast, deficit / surplus risk. Read only. */
export const GET = handle(async (req: Request) => {
  await currentUser();
  const rt = await getRuntime();
  const { snap, result } = await rt.analysis(modeFrom(req));
  return mobileAnalytics(snap, result);
});
