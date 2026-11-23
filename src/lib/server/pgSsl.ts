import type { ConnectionOptions } from "node:tls";

/**
 * SSL options for every PostgreSQL pool, from the environment:
 *   DATABASE_SSL=true          — use SSL
 *   DATABASE_SSL_STRICT=false  — accept a provider's own certificate chain (Supabase pooler)
 *   DATABASE_SSL_CA=<PEM>      — or verify against that provider CA (the safer way; strict stays on)
 * Values are read loosely ("false", " False ", "\"false\"") — a stray space or quotes in the hosting panel must not
 * take the whole app down.
 */
const flag = (v: string | undefined) => (v ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase();

export function pgSsl(): boolean | ConnectionOptions | undefined {
  if (flag(process.env.DATABASE_SSL) !== "true") return undefined;
  const ca = process.env.DATABASE_SSL_CA?.trim();
  if (ca) return { ca: ca.replace(/\\n/g, "\n"), rejectUnauthorized: true };
  return { rejectUnauthorized: !["false", "0", "no", "off"].includes(flag(process.env.DATABASE_SSL_STRICT)) };
}

/**
 * The connection string without `sslmode=…`: node-postgres lets the string override the `ssl` object, so a pasted
 * `?sslmode=require` would silently turn strict verification back on. With DATABASE_SSL set, the env decides.
 */
export function pgUrl(url: string): string {
  if (!pgSsl()) return url;
  return url.replace(/([?&])sslmode=[^&]*(&|$)/, (_, a: string, b: string) => (b ? a : "")).replace(/[?&]$/, "");
}

/** One line for the startup log: how SSL is set up (never the URL or a password). */
export function pgSslSummary(url: string | undefined): string {
  const ssl = pgSsl();
  const sslmode = url ? (/[?&]sslmode=([^&]+)/.exec(url)?.[1] ?? "нет") : "нет";
  const host = url ? (/@([^:/?]+)/.exec(url)?.[1] ?? "?") : "?";
  return `db host=${host} · ssl=${ssl ? "on" : "off"} · strict=${typeof ssl === "object" ? ssl.rejectUnauthorized !== false : "-"} · ca=${process.env.DATABASE_SSL_CA ? "yes" : "no"} · sslmode в строке=${sslmode}`;
}
