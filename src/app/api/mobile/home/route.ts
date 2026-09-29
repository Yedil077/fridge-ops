import { currentUser, handle } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { mobileHome } from "@/lib/server/mobile";
import { modeFrom } from "@/lib/server/mode";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: Request) => {
  const user = await currentUser();
  const rt = await getRuntime();
  await rt.ensureFreshAnalysis();
  const mode = modeFrom(req);
  const { snap, result } = await rt.analysis(mode);
  return mobileHome(snap, result, rt.state, user, rt.mode, mode);
});
