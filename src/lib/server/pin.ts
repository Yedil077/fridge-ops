import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * PIN & session token primitives (Node crypto only, no dependencies).
 * PINs are stored as scrypt hashes with a per-user salt; session tokens are random and
 * only their sha256 is stored, so a leaked database cannot be replayed as a session.
 */

const N = 16384;
const KEYLEN = 32;

export function isValidPin(pin: string): boolean {
  return /^\d{4,8}$/.test(pin);
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, KEYLEN, { N });
  return `scrypt$${N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [alg, n, saltB64, hashB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(pin, Buffer.from(saltB64, "base64"), expected.length, { N: Number(n) || N });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}
