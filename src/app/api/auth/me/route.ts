import { handle, requireUser } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const u = await requireUser();
  const rt = await getRuntime();
  const snap = await rt.snapshot();
  return { id: u.id, login: u.login, name: u.name, role: u.role, mode: rt.mode, closeTime: rt.untilTime(), untilTime: rt.untilTime(), untilPassed: rt.untilPassed(snap) };
});
