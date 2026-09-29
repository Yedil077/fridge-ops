import { z } from "zod";
import { currentUser, handle } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { historyView } from "@/lib/server/views";

export const dynamic = "force-dynamic";

const Query = z.object({
  range: z.coerce.number().int().refine((v) => [7, 30, 90, 180].includes(v)).default(30),
  fridge: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
});

export const GET = handle(async (req: Request) => {
  await currentUser("ADMIN");
  const url = new URL(req.url);
  const q = Query.parse({ range: url.searchParams.get("range") ?? undefined, fridge: url.searchParams.get("fridge") || undefined });
  const rt = await getRuntime();
  const { result } = await rt.analysis();
  return historyView(result.ctx, rt.state, q.range, q.fridge ?? null);
});
