import { z } from "zod";
import { handle, requireUser } from "@/lib/server/http";
import { getRuntime, HttpError } from "@/lib/server/runtime";
import { kitshopLiveStarted } from "@/lib/server/kitshopLive";
import { menuFromSheet } from "@/lib/server/tomorrowView";

export const dynamic = "force-dynamic";

const Body = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), sheet: z.string().min(1).max(100) });

/** Menu from a Google Sheets tab (MANAGER+). The sheet is only READ (public CSV query) — nothing is written there. */
export const POST = handle(async (req: Request) => {
  const user = await requireUser("MANAGER");
  const live = kitshopLiveStarted();
  if (!live) throw new HttpError(409, "Только с реальными данными KiT Shop");
  await live.ready();
  const b = Body.parse(await req.json());
  const r = await menuFromSheet(live, b.sheet);
  await live.repo.setMenu(b.date, r.matched.map((m) => ({ productId: m.productId, source: `Google Sheets «${b.sheet}»` })), [], user.name);
  (await getRuntime()).ops.audit(user.name, "tomorrow.import", "tomorrow", b.date, { sheet: b.sheet, matched: r.matched.length, unmatched: r.unmatched.length });
  return r;
});
