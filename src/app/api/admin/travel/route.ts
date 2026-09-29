import { z } from "zod";
import { handle, requireUser } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";

const Body = z.object({
  a: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  b: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  minutes: z.number().int().min(1).max(240).nullable(),
});

/** Manual travel time between two fridges (overrides coordinates / proximity groups). */
export const PUT = handle(async (req: Request) => {
  (await requireUser("ADMIN")).name;
  const { a, b, minutes } = Body.parse(await req.json());
  (await getRuntime()).setTravelOverride(a, b, minutes);
  return { ok: true };
});
