import { currentUser, handle } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { mobileTasks } from "@/lib/server/mobile";
import { modeFrom } from "@/lib/server/mode";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: Request) => {
  const user = await currentUser();
  const rt = await getRuntime();
  const snap = await rt.snapshot();
  return mobileTasks(snap, rt.state, user, modeFrom(req));
});
