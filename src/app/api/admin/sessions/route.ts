import { handle, requireUser } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

/** Active device sessions (no tokens — only metadata). */
export const GET = handle(async () => {
  const me = await requireUser("ADMIN");
  const rt = await getRuntime();
  const now = Date.now();
  const users = new Map(rt.state.users.map((u) => [u.id, u]));
  return {
    sessions: rt.state.sessions
      .filter((s) => !s.revokedAt && s.expiresAt > now)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((s) => ({
        id: s.id,
        user: users.get(s.userId)?.name ?? "?",
        role: users.get(s.userId)?.role ?? "EMPLOYEE",
        device: s.device,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        current: s.id === me.sessionId,
      })),
  };
});
