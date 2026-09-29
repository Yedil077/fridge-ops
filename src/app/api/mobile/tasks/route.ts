import { currentUser, handle } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { mobileTasks } from "@/lib/server/mobile";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const user = await currentUser();
  const rt = await getRuntime();
  const snap = await rt.snapshot();
  return mobileTasks(snap, rt.state, user);
});
