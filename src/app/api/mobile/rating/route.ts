import { currentUser, handle } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { mobileRating } from "@/lib/server/mobile";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const user = await currentUser();
  const rt = await getRuntime();
  const { snap, result } = await rt.analysis();
  return mobileRating(snap, result, rt.state, user);
});
