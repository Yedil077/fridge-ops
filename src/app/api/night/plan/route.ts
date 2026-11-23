import { z } from "zod";
import { handle, requireUser } from "@/lib/server/http";
import { getRuntime, HttpError } from "@/lib/server/runtime";
import { kitshopLiveStarted } from "@/lib/server/kitshopLive";
import { wallClockNow } from "@/lib/time";

export const dynamic = "force-dynamic";

const Body = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** e.g. "Каспи Меню по неделям · 24.11.2026 Tuesday" */
  source: z.string().min(1).max(200),
  rows: z
    .array(
      z.object({
        shopId: z.string().regex(/^\d{1,12}$/),
        name: z.string().min(1).max(200),
        productId: z.string().regex(/^\d{1,18}$/).nullable().default(null),
        group: z.string().min(1).max(60),
        qty: z.number().int().min(0).max(500),
      }),
    )
    .max(2000),
});

/**
 * The kitchen's table of new product for a delivery date (MANAGER+), exactly as read from Google Sheets — the table is
 * the priority and is never changed by the app. Re-importing a date replaces it (17:00 draft, 19:00 update).
 */
export const PUT = handle(async (req: Request) => {
  const user = await requireUser("MANAGER");
  const live = kitshopLiveStarted();
  if (!live) throw new HttpError(409, "Только с реальными данными KiT Shop");
  const b = Body.parse(await req.json());
  const ours = new Set([...live.ds.shops.keys()]);
  const unknown = [...new Set(b.rows.map((r) => r.shopId).filter((s) => !ours.has(s)))];
  if (unknown.length) throw new HttpError(400, `Неизвестные холодильники: ${unknown.join(", ")}`);
  await live.repo.setNightPlan(b.date, { source: b.source, importedAt: wallClockNow(process.env.APP_TIMEZONE || "Asia/Almaty"), importedBy: user.name, rows: b.rows });
  (await getRuntime()).ops.audit(user.name, "night.plan", "night", b.date, { source: b.source, rows: b.rows.length, units: b.rows.reduce((a, r) => a + r.qty, 0) });
  return { ok: true, rows: b.rows.length };
});
