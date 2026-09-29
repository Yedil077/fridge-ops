import { z } from "zod";
import { handle, requireUser } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { newId } from "@/lib/server/pin";

const Body = z.object({ platform: z.enum(["android", "web"]), token: z.string().min(10).max(4096) });

/**
 * Registers a push token for the current user (future FCM push). Tokens are stored in OUR database;
 * the backend decides what is important enough to send (see lib/server/notifications.ts).
 */
export const POST = handle(async (req: Request) => {
  const u = await requireUser();
  const b = Body.parse(await req.json());
  const rt = await getRuntime();
  const now = Date.now();
  const existing = rt.state.devices.find((d) => d.token === b.token);
  if (existing) {
    existing.userId = u.id;
    existing.lastSeenAt = now;
  } else rt.state.devices.push({ id: newId("D"), userId: u.id, platform: b.platform, token: b.token, createdAt: now, lastSeenAt: now });
  rt.save();
  return { ok: true };
});
