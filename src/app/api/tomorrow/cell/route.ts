import { z } from "zod";
import { handle, requireUser } from "@/lib/server/http";
import { getRuntime, HttpError } from "@/lib/server/runtime";
import { kitshopLiveStarted } from "@/lib/server/kitshopLive";

export const dynamic = "force-dynamic";

const Body = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shopId: z.string().regex(/^\d{1,12}$/),
  productId: z.string().regex(/^\d{1,18}$/),
  /** the manager's own number; null = back to the recommendation */
  qty: z.number().int().min(0).max(500).nullable(),
});

/** Manual correction of one cell (MANAGER+). The recommendation is kept next to it for later comparison. */
export const PUT = handle(async (req: Request) => {
  const user = await requireUser("MANAGER");
  const live = kitshopLiveStarted();
  if (!live) throw new HttpError(409, "Только с реальными данными KiT Shop");
  const b = Body.parse(await req.json());
  await live.repo.setManual(b.date, b.shopId, b.productId, b.qty, user.name);
  (await getRuntime()).ops.audit(user.name, "tomorrow.manual", "tomorrow", `${b.date}:${b.shopId}:${b.productId}`, { qty: b.qty });
  return { ok: true };
});
