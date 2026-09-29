import { currentUser, handle } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { dashboardView } from "@/lib/server/views";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const user = await currentUser("MANAGER");
  const rt = await getRuntime();
  await rt.ensureFreshAnalysis();
  const { snap, result } = await rt.analysis();
  return dashboardView(snap, result, rt.state, user, rt.mode);
});
