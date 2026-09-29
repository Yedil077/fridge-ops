import { z } from "zod";
import { currentUser, handle } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept") }),
  z.object({ action: z.literal("start") }),
  z.object({
    action: z.literal("complete"),
    quantities: z.record(z.string(), z.number().int().min(0).max(200)).optional(),
    items: z
      .array(
        z.object({
          lineIndex: z.number().int().min(0).max(50),
          productId: z.string().max(60),
          qty: z.number().int().min(0).max(200),
          unavailable: z.boolean().optional(),
        }),
      )
      .max(200)
      .optional(),
  }),
  z.object({ action: z.literal("skip"), reason: z.string().max(200).optional() }),
]);

export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await currentUser();
  const { id } = await ctx.params;
  const body = Body.parse(await req.json());
  return (await getRuntime()).missionAction(id, user, body);
});
