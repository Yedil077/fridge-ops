import { handle, requireUser } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { revokeSession } from "@/lib/server/users";

/** Revoke one device session — the phone is logged out on its next request. */
export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await requireUser("ADMIN");
  const { id } = await ctx.params;
  const rt = await getRuntime();
  revokeSession(rt.state, id, admin.name);
  await rt.flushNow();
  return { ok: true };
});
