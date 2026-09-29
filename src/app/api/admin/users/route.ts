import { z } from "zod";
import { handle, requireUser } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { createUser, publicUser } from "@/lib/server/users";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  await requireUser("ADMIN");
  const rt = await getRuntime();
  const now = Date.now();
  return {
    users: rt.state.users.map((u) => ({
      ...publicUser(u),
      activeSessions: rt.state.sessions.filter((s) => s.userId === u.id && !s.revokedAt && s.expiresAt > now).length,
    })),
  };
});

const Role = z.enum(["EMPLOYEE", "MANAGER", "ADMIN"]);
const Body = z.object({
  login: z.string().trim().min(2).max(32),
  name: z.string().trim().min(1).max(40),
  role: Role,
  pin: z.string().regex(/^\d{4,8}$/),
});

export const POST = handle(async (req: Request) => {
  await requireUser("ADMIN");
  const b = Body.parse(await req.json());
  const rt = await getRuntime();
  const u = createUser(rt.state, b);
  await rt.flushNow();
  return publicUser(u);
});
