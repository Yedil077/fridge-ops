import { NextResponse } from "next/server";
import { z } from "zod";
import { ROLE_COOKIE, SESSION_COOKIE, signRoleHint } from "@/lib/auth";
import { getRuntime } from "@/lib/server/runtime";
import { AuthError, login, publicUser, SESSION_DAYS } from "@/lib/server/users";

const Body = z.object({
  login: z.string().trim().min(2).max(40),
  pin: z.string().regex(/^\d{4,8}$/),
  device: z.string().max(120).optional(),
});

/** Employee login: login (or name) + PIN → revocable session stored in OUR database. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Введите логин и PIN (4–8 цифр)" }, { status: 400 });
  const rt = await getRuntime();
  try {
    const device = parsed.data.device || req.headers.get("user-agent")?.slice(0, 120) || "unknown";
    const { token, user } = login(rt.state, parsed.data.login, parsed.data.pin, device);
    await rt.flushNow();
    const res = NextResponse.json({ user: publicUser(user) });
    const secure = process.env.NODE_ENV === "production";
    const maxAge = SESSION_DAYS * 86_400;
    res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge });
    res.cookies.set(ROLE_COOKIE, await signRoleHint(user.role), { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge });
    return res;
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
