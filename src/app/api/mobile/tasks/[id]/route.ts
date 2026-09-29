import { currentUser, handle } from "@/lib/server/http";
import { getRuntime, HttpError } from "@/lib/server/runtime";
import { mobileRoute } from "@/lib/server/mobile";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await currentUser();
  const { id } = await ctx.params;
  const rt = await getRuntime();
  const m = rt.state.missions.find((x) => x.id === id);
  if (!m) throw new HttpError(404, "Задача не найдена");
  const snap = await rt.snapshot();
  return { now: snap.now, route: mobileRoute(m, snap) };
});
