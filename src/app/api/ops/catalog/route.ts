import { handle, requireUser } from "@/lib/server/http";
import { getRuntime, HttpError } from "@/lib/server/runtime";
import { opsCatalog } from "@/lib/server/opsViews";

export const dynamic = "force-dynamic";

/** Products with current stock of one fridge + KiT Shop mapping status (scan / load screen, stock screen). */
export const GET = handle(async (req: Request) => {
  await requireUser();
  const fridgeId = new URL(req.url).searchParams.get("fridgeId");
  if (!fridgeId) throw new HttpError(400, "fridgeId обязателен");
  const view = await opsCatalog(await getRuntime(), fridgeId);
  if (!view.fridge) throw new HttpError(404, "Холодильник не найден");
  return view;
});
