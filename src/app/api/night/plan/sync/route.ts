import { z } from "zod";
import { handle, requireUser } from "@/lib/server/http";
import { getRuntime, HttpError } from "@/lib/server/runtime";
import { kitshopLiveStarted } from "@/lib/server/kitshopLive";
import { importMenuPlan } from "@/lib/server/menuSheet";

export const dynamic = "force-dynamic";

const Body = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/**
 * «Обновить из таблицы» (MANAGER+): reads the kitchen's table now (Google Drive, read only) and replaces the date's
 * plan with it — the same as the automatic 17:00 / 19:00 read.
 */
export const POST = handle(async (req: Request) => {
  const user = await requireUser("MANAGER");
  const live = kitshopLiveStarted();
  if (!live) throw new HttpError(409, "Только с реальными данными KiT Shop");
  const { date } = Body.parse(await req.json());
  let r;
  try {
    r = await importMenuPlan(live.repo, date, `таблица · ${user.name}`);
  } catch (e) {
    throw new HttpError(502, e instanceof Error ? e.message : String(e));
  }
  (await getRuntime()).ops.audit(user.name, "night.plan.sheet", "night", date, { ...r });
  return { ok: true, ...r };
});
