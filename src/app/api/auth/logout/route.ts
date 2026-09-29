import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ROLE_COOKIE, SESSION_COOKIE } from "@/lib/auth";
import { getRuntime } from "@/lib/server/runtime";
import { revokeSession, validate } from "@/lib/server/users";

/** Logs out THIS device: the session is revoked server-side, not just forgotten by the browser. */
export async function POST() {
  const jar = await cookies();
  const rt = await getRuntime();
  const v = validate(rt.state, jar.get(SESSION_COOKIE)?.value);
  if (v) {
    revokeSession(rt.state, v.user.sessionId, v.user.name);
    await rt.flushNow();
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  res.cookies.delete(ROLE_COOKIE);
  return res;
}
