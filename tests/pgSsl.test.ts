import { test } from "node:test";
import assert from "node:assert/strict";
import { pgSsl, pgSslSummary, pgUrl } from "../src/lib/server/pgSsl";

/** A stray space / quotes / capital letter in the hosting panel must not switch strict certificate checks back on. */
test("DATABASE_SSL_STRICT is read loosely; a CA turns strict verification on", () => {
  const env = process.env;
  const set = (o: Record<string, string | undefined>) => {
    for (const k of ["DATABASE_SSL", "DATABASE_SSL_STRICT", "DATABASE_SSL_CA"]) delete env[k];
    Object.assign(env, o);
  };
  set({});
  assert.equal(pgSsl(), undefined);
  for (const v of ["false", " false ", "\"false\"", "False", "0", "no"]) {
    set({ DATABASE_SSL: "true", DATABASE_SSL_STRICT: v });
    assert.deepEqual(pgSsl(), { rejectUnauthorized: false }, v);
  }
  set({ DATABASE_SSL: " true" });
  assert.deepEqual(pgSsl(), { rejectUnauthorized: true });
  set({ DATABASE_SSL: "true", DATABASE_SSL_STRICT: "false", DATABASE_SSL_CA: "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----" });
  assert.deepEqual(pgSsl(), { ca: "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----", rejectUnauthorized: true });
  set({ DATABASE_SSL: "true", DATABASE_SSL_STRICT: "false" });
  const s = pgSslSummary("postgresql://postgres.abc:secret@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require");
  assert.match(s, /host=aws-0-eu-central-1\.pooler\.supabase\.com/);
  assert.match(s, /strict=false/);
  assert.match(s, /sslmode в строке=require/);
  assert.ok(!s.includes("secret"), "never the password");
  set({});
});

test("a pasted ?sslmode=… is dropped when DATABASE_SSL decides", () => {
  process.env.DATABASE_SSL = "true";
  assert.equal(pgUrl("postgresql://u:p@h:5432/postgres?sslmode=require"), "postgresql://u:p@h:5432/postgres");
  assert.equal(pgUrl("postgresql://u:p@h:5432/postgres?sslmode=require&x=1"), "postgresql://u:p@h:5432/postgres?x=1");
  assert.equal(pgUrl("postgresql://u:p@h:5432/postgres?x=1&sslmode=require"), "postgresql://u:p@h:5432/postgres?x=1");
  assert.equal(pgUrl("postgresql://u:p@h:5432/postgres"), "postgresql://u:p@h:5432/postgres");
  delete process.env.DATABASE_SSL;
});

test("the startup line never shows a password, and says what is wrong with a pasted string", () => {
  process.env.DATABASE_SSL = "true";
  const s = pgSslSummary("postgresql://postgres.ref:[se@cret]@aws-0-eu-central-1.pooler.supabase.com:5432/postgres");
  assert.match(s, /host=aws-0-eu-central-1\.pooler\.supabase\.com /);
  assert.ok(!s.includes("se@cret") && !s.includes("cret"), s);
  assert.match(s, /2 знака @/);
  assert.match(s, /\[ \]/);
  delete process.env.DATABASE_SSL;
});
