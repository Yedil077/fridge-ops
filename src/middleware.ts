import { NextResponse, type NextRequest } from "next/server";
import { readRoleHint, ROLE_COOKIE, SESSION_COOKIE } from "./lib/auth";

/** Cookie set by "Полная версия" / "Мобильная версия" switches. */
const VIEW_COOKIE = "fo_view";
const MOBILE_UA = /Android|iPhone|iPod|Mobile|Windows Phone|webOS|BlackBerry/i;
const PUBLIC = ["/login", "/api/auth/login", "/api/health", "/manifest.webmanifest", "/sw.js"];

/** Desktop areas and the minimum role for them (routing only — APIs enforce roles themselves). */
const DESKTOP_AREAS: { prefix: string; role: "MANAGER" | "ADMIN" }[] = [
  { prefix: "/admin", role: "ADMIN" },
  { prefix: "/analytics", role: "ADMIN" },
  { prefix: "/fridges", role: "MANAGER" },
];
const RANK: Record<string, number> = { EMPLOYEE: 1, MANAGER: 2, ADMIN: 3 };

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // CSRF defence in depth: state-changing API calls must come from our own origin
  if (pathname.startsWith("/api/") && req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    if (origin && new URL(origin).host !== req.headers.get("host")) {
      return NextResponse.json({ error: "Bad origin" }, { status: 403 });
    }
  }

  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();

  if (!req.cookies.get(SESSION_COOKIE)?.value) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  if (pathname.startsWith("/api/")) return NextResponse.next();

  const role = (await readRoleHint(req.cookies.get(ROLE_COOKIE)?.value)) ?? "EMPLOYEE";
  const toMobile = () => {
    const url = req.nextUrl.clone();
    url.pathname = "/m";
    url.search = "";
    return NextResponse.redirect(url);
  };

  if (pathname === "/") {
    // employees and phones get the staff interface; managers on desktop keep the command center
    if (RANK[role] < RANK.MANAGER) return toMobile();
    if (req.cookies.get(VIEW_COOKIE)?.value !== "desktop" && MOBILE_UA.test(req.headers.get("user-agent") ?? "")) return toMobile();
  }
  const area = DESKTOP_AREAS.find((a) => pathname.startsWith(a.prefix));
  if (area && RANK[role] < RANK[area.role]) return toMobile();
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|icons/).*)"],
};
