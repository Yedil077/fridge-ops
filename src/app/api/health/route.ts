import { NextResponse } from "next/server";
import { getRuntime } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

/** Liveness / readiness for Docker, uptime monitors and CI smoke checks. No secrets, no auth. */
export async function GET() {
  try {
    const rt = await getRuntime();
    return NextResponse.json({ ok: true, mode: rt.mode, store: rt.store.kind, time: new Date().toISOString() });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
