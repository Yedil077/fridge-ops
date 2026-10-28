import { z } from "zod";
import { handle, requireUser } from "@/lib/server/http";
import { getRuntime, HttpError } from "@/lib/server/runtime";
import { kitshopLiveStarted } from "@/lib/server/kitshopLive";

export const dynamic = "force-dynamic";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Body = z.object({
  date: Day,
  add: z.array(z.string().regex(/^\d{1,18}$/)).max(200).default([]),
  remove: z.array(z.string().regex(/^\d{1,18}$/)).max(200).default([]),
  /** copy the menu of another date */
  copyFrom: Day.optional(),
});

/** The menu of a date (MANAGER+): Apps Холодосов never chooses dishes, it only counts how many. */
export const PUT = handle(async (req: Request) => {
  const user = await requireUser("MANAGER");
  const live = kitshopLiveStarted();
  if (!live) throw new HttpError(409, "Только с реальными данными KiT Shop");
  const b = Body.parse(await req.json());
  const add = b.add.map((productId) => ({ productId, source: "вручную" }));
  if (b.copyFrom) for (const m of await live.repo.getMenu(b.copyFrom)) add.push({ productId: m.productId, source: `копия ${b.copyFrom}` });
  await live.repo.setMenu(b.date, add, b.remove, user.name);
  (await getRuntime()).ops.audit(user.name, "tomorrow.menu", "tomorrow", b.date, { add: add.map((a) => a.productId), remove: b.remove });
  return { menu: await live.repo.getMenu(b.date) };
});
