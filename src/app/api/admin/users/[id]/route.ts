import { z } from "zod";
import { handle, requireUser } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { publicUser, revokeUserSessions, updateUser } from "@/lib/server/users";

const Body = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  role: z.enum(["EMPLOYEE", "MANAGER", "ADMIN"]).optional(),
  pin: z.string().regex(/^\d{4,8}$/).optional(),
  active: z.boolean().optional(),
  revokeSessions: z.boolean().optional(),
});

/** Update role / reset PIN (logs out everywhere) / deactivate / revoke all sessions. */
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await requireUser("ADMIN");
  const { id } = await ctx.params;
  const b = Body.parse(await req.json());
  const rt = await getRuntime();
  const u = updateUser(rt.state, id, b, admin);
  if (b.revokeSessions) revokeUserSessions(rt.state, u.id, admin.name);
  await rt.flushNow();
  return publicUser(u);
});
