import { currentUser, handle } from "@/lib/server/http";
import { getRuntime, HttpError } from "@/lib/server/runtime";
import { mobileFridge } from "@/lib/server/mobile";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await currentUser();
  const { id } = await ctx.params;
  const { snap, result } = await (await getRuntime()).analysis();
  const view = mobileFridge(snap, result, id);
  if (!view) throw new HttpError(404, "Холодильник не найден");
  return view;
});
