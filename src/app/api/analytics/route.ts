import { currentUser, handle } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { analyticsView } from "@/lib/server/views";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  await currentUser("ADMIN");
  const rt = await getRuntime();
  const { snap, result } = await rt.analysis();
  return analyticsView(snap, result, rt.state);
});
