import { currentUser, handle } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { dashboardView } from "@/lib/server/views";
import { modeFrom } from "@/lib/server/mode";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: Request) => {
  const user = await currentUser("MANAGER");
  const rt = await getRuntime();
  await rt.ensureFreshAnalysis();
  const { snap, result } = await rt.analysis(modeFrom(req));
  const mode = rt.effectiveMode(modeFrom(req), snap);
  return dashboardView(snap, result, rt.state, user, rt.mode, mode);
});
