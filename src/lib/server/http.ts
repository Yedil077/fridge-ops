import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { SESSION_COOKIE } from "../auth";
import type { Role } from "../store/appStore";
import { getRuntime, HttpError } from "./runtime";
import { AuthError, ROLE_RANK, validate, type SessionUser } from "./users";
import { KitShopNotReadyError } from "@/services/kitshop";
import { isOpsError } from "../kitshop-ops/service";

/**
 * Authenticated user of the request, checked against the session table in OUR database
 * (revoked or expired sessions are rejected immediately). Optionally requires a minimum role.
 */
export async function requireUser(minRole: Role = "EMPLOYEE"): Promise<SessionUser> {
  const jar = await cookies();
  const rt = await getRuntime();
  const res = validate(rt.state, jar.get(SESSION_COOKIE)?.value);
  if (!res) throw new HttpError(401, "Unauthorized");
  if (res.touched) rt.save();
  if (ROLE_RANK[res.user.role] < ROLE_RANK[minRole]) throw new HttpError(403, "Недостаточно прав");
  return res.user;
}

/** Display name of the current user (players / missions are keyed by it). */
export async function currentUser(minRole: Role = "EMPLOYEE"): Promise<string> {
  return (await requireUser(minRole)).name;
}

/** Wraps a route handler: consistent JSON errors, no stack traces or secrets leaked to the client. */
export function handle<T extends unknown[]>(fn: (...args: T) => Promise<unknown>) {
  return async (...args: T) => {
    try {
      const data = await fn(...args);
      return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      if (e instanceof HttpError || e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
      if (e instanceof ZodError) return NextResponse.json({ error: "Некорректный запрос", issues: e.issues }, { status: 400 });
      if (isOpsError(e)) return NextResponse.json({ error: e.message, code: e.code, details: e.details ?? null }, { status: e.status });
      if (e instanceof KitShopNotReadyError || (e as Error)?.name === "KitShopNotReadyError") return NextResponse.json({ error: (e as Error).message, code: "KITSHOP_NOT_READY" }, { status: 503 });
      if ((e as Error)?.name === "KitShopResultError") return NextResponse.json({ error: (e as Error).message, code: "KITSHOP_ERROR" }, { status: 502 });
      console.error(e);
      return NextResponse.json({ error: "Внутренняя ошибка" }, { status: 500 });
    }
  };
}
