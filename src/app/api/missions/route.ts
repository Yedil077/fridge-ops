import { currentUser, handle } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { missionsView } from "@/lib/server/views";
import { modeFrom } from "@/lib/server/mode";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: Request) => {
  await currentUser();
  const rt = await getRuntime();
  const snap = await rt.snapshot();
  return missionsView(rt.state, snap.today.day, rt.names(snap), rt.effectiveMode(modeFrom(req), snap));
});

/** Run the analysis now (normally it runs every hour). */
export const POST = handle(async () => {
  await currentUser("MANAGER");
  const created = await (await getRuntime()).runHourly();
  return { created: created.length };
});
