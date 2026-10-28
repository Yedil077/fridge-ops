import { z } from "zod";
import { handle, requireUser } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { DEFAULT_SHELF_HOURS } from "@/lib/config/shelfLife";

export const dynamic = "force-dynamic";

/** App-wide settings: the clock time of the "ДО HH:MM" forecast mode and the shelf lives (срок годности). */
export const GET = handle(async () => {
  await requireUser("ADMIN");
  const rt = await getRuntime();
  const s = rt.shelfLife();
  return {
    untilTime: rt.untilTime(),
    shelfLife: { defaults: DEFAULT_SHELF_HOURS, categories: { ...DEFAULT_SHELF_HOURS, ...s.categories }, products: s.products },
  };
});

const Hours = z.number().int().min(6).max(336);
const Body = z.object({
  untilTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  /** hours per category / per dish; null removes a dish override (the category value applies again) */
  shelfLife: z
    .object({
      categories: z.record(z.string().max(40), Hours).optional(),
      products: z.record(z.string().max(40), Hours.nullable()).optional(),
    })
    .optional(),
});

export const PUT = handle(async (req: Request) => {
  const admin = await requireUser("ADMIN");
  const body = Body.parse(await req.json());
  const rt = await getRuntime();
  if (body.untilTime) {
    rt.setUntilMinute(Number(body.untilTime.slice(0, 2)) * 60 + Number(body.untilTime.slice(3)));
    rt.ops.audit(admin.name, "settings.until_time", "settings", "untilTime", { untilTime: body.untilTime });
  }
  if (body.shelfLife) {
    const cur = rt.shelfLife();
    const products = { ...cur.products };
    for (const [id, h] of Object.entries(body.shelfLife.products ?? {})) {
      if (h === null) delete products[id];
      else products[id] = h;
    }
    const next = { categories: { ...cur.categories, ...(body.shelfLife.categories ?? {}) }, products };
    rt.setShelfLife(next);
    rt.ops.audit(admin.name, "settings.shelf_life", "settings", "shelfLife", body.shelfLife);
  }
  const s = rt.shelfLife();
  return { untilTime: rt.untilTime(), shelfLife: { defaults: DEFAULT_SHELF_HOURS, categories: { ...DEFAULT_SHELF_HOURS, ...s.categories }, products: s.products } };
});
