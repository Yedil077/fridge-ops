import { z } from "zod";
import { handle, requireUser } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { opsList, opView } from "@/lib/server/opsViews";
import { OPEN_STATUSES } from "@/lib/kitshop-ops/types";
import { ROLE_RANK } from "@/lib/server/users";

export const dynamic = "force-dynamic";

/** KiT Shop operations journal. Employees see their own; managers see everything (СИНХРОНИЗАЦИЯ). */
export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  const rt = await getRuntime();
  const url = new URL(req.url);
  const manager = ROLE_RANK[user.role] >= ROLE_RANK.MANAGER;
  if (manager && url.searchParams.get("sync") === "1") await rt.ops.tick(user.name);
  const missionId = url.searchParams.get("missionId") ?? undefined;
  const attention = url.searchParams.get("status") === "open";
  const now = rt.sim?.now ?? Date.now();
  let ops = rt.ops.list({
    status: attention ? [...OPEN_STATUSES, "FAILED"] : undefined,
    missionId,
    user: manager || missionId ? undefined : user.name,
    limit: 150,
  });
  // "needs attention": open ones + failures of the last 24 h (older failures stay in "Все")
  if (attention) ops = ops.filter((o) => o.status !== "FAILED" || now - o.createdAt < 86_400_000);
  return opsList(rt, ops, now);
});

const Body = z.object({
  /** operation_uuid generated on the phone — the idempotency key */
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  type: z.enum(["LOAD", "UNLOAD", "WRITE_OFF"]),
  fridgeId: z.string().max(40),
  items: z.array(z.object({ productId: z.string().max(60), qty: z.number().int().min(0).max(500) })).min(1).max(100),
  reason: z.string().max(120).optional(),
});

/** Synchronous: answers after KiT Shop confirmed / refused, or after the timeout with UNKNOWN. */
export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const body = Body.parse(await req.json());
  const rt = await getRuntime();
  const { op, duplicate } = await rt.submitOperation(body, user.name);
  return { operation: opView(op), duplicate };
});
