import { currentUser, handle } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { mobileFridges } from "@/lib/server/mobile";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  await currentUser();
  const { snap, result } = await (await getRuntime()).analysis();
  return mobileFridges(snap, result);
});
