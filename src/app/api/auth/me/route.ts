import { handle, requireUser } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const u = await requireUser();
  const rt = await getRuntime();
  // the session must work even while the first KiT Shop sync is still loading
  const snap = await rt.snapshot().catch(() => null);
  const ds = rt.dataStatus();
  return {
    id: u.id,
    login: u.login,
    name: u.name,
    role: u.role,
    mode: rt.mode,
    readOnly: rt.readOnly,
    /** XP / OPS POINTS / rewards are hidden unless SHOW_REWARDS=true */
    rewards: process.env.SHOW_REWARDS === "true",
    dataSource: ds.label,
    lastSyncAt: ds.lastSuccessAt,
    closeTime: rt.untilTime(),
    untilTime: rt.untilTime(),
    untilPassed: snap ? rt.untilPassed(snap) : false,
  };
});
