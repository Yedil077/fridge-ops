import { currentUser, handle } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { mobileHome } from "@/lib/server/mobile";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const user = await currentUser();
  const rt = await getRuntime();
  await rt.ensureFreshAnalysis();
  const { snap, result } = await rt.analysis();
  return mobileHome(snap, result, rt.state, user, rt.mode);
});
