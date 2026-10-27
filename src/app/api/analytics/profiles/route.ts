import { currentUser, handle } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { profilesView } from "@/lib/server/profilesView";

export const dynamic = "force-dynamic";

/** Профили холодильников (every role): individual norm, today vs norm, needs / can give, group comparison. Read only. */
export const GET = handle(async () => {
  await currentUser();
  const rt = await getRuntime();
  await rt.ensureFreshAnalysis();
  const { snap, result } = await rt.analysis("realtime");
  return profilesView(snap, result, rt.state, rt.untilMinute());
});
