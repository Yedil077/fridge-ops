/**
 * Edge-safe auth helpers used by middleware.
 *
 * The real session check happens on the server (API routes → lib/server/users.ts) against the
 * sessions stored in OUR database, so sessions are revocable. Middleware cannot reach the database;
 * it only uses:
 *  • SESSION_COOKIE — opaque random token (presence check → redirect to /login)
 *  • ROLE_COOKIE    — HMAC-signed role hint, used ONLY to route employees to /m.
 *                     It is never trusted for access control; every API checks the role itself.
 */

export const SESSION_COOKIE = "fo_session";
export const ROLE_COOKIE = "fo_role";

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (s && s !== "change-me-to-a-long-random-string") return s;
  if (process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET must be set in production");
  return "fridge-ops-dev-secret";
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

export async function signRoleHint(role: string): Promise<string> {
  return `${role}.${await hmac(`role:${role}`)}`;
}

export async function readRoleHint(value: string | undefined | null): Promise<string | null> {
  if (!value) return null;
  const [role, sig] = value.split(".");
  if (!role || !sig) return null;
  return (await hmac(`role:${role}`)) === sig ? role : null;
}
