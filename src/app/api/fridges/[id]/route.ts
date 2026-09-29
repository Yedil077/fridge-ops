import { currentUser, handle } from "@/lib/server/http";
import { getRuntime, HttpError } from "@/lib/server/runtime";
import { fridgeDetailView } from "@/lib/server/views";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await currentUser("MANAGER");
  const { id } = await ctx.params;
  const rt = await getRuntime();
  const { snap, result } = await rt.analysis();
  const view = fridgeDetailView(snap, result, id, rt.state);
  if (!view) throw new HttpError(404, "Холодильник не найден");
  return view;
});
