import { NextResponse } from "next/server";
import { getRuntime } from "@/lib/server/runtime";
import { kitshopLiveStarted } from "@/lib/server/kitshopLive";
import { autoUnusedReport } from "@/lib/server/unusedReport";

export const dynamic = "force-dynamic";

/** when this server process started (a new deploy = a new start) */
const STARTED_AT = new Date().toISOString();

/** Liveness / readiness for Docker, uptime monitors and CI smoke checks. No secrets, no auth. */
export async function GET() {
  try {
    const rt = await getRuntime();
    // an uptime monitor pinging /api/health also keeps the 5-minute KiT Shop sync going on free hosting
    kitshopLiveStarted()?.nudge();
    void autoUnusedReport().catch(() => undefined);
    const ds = rt.dataStatus();
    return NextResponse.json({
      ok: true,
      // the deployed commit (Render sets RENDER_GIT_COMMIT) — to check which version really runs
      commit: (process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? "").slice(0, 7) || null,
      startedAt: STARTED_AT,
      mode: rt.mode,
      store: rt.store.kind,
      dataSource: ds.label,
      lastSyncAt: ds.lastSuccessAt,
      readOnly: rt.readOnly,
      time: new Date().toISOString(),
    });
  } catch (e) {
    // make startup problems visible in the platform logs (Render / Docker)
    console.error("[health] runtime failed to start:", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, reason: "startup_failed" }, { status: 503 });
  }
}
