import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPin, isValidPin, newToken, tokenHash, verifyPin } from "../src/lib/server/pin";

test("PIN is stored as a salted hash and verifies", () => {
  const h = hashPin("4821");
  assert.ok(!h.includes("4821"));
  assert.ok(h.startsWith("scrypt$"));
  assert.equal(verifyPin("4821", h), true);
  assert.equal(verifyPin("4822", h), false);
  assert.notEqual(hashPin("4821"), h, "salt makes hashes unique");
});

test("PIN format", () => {
  assert.equal(isValidPin("1234"), true);
  assert.equal(isValidPin("12345678"), true);
  assert.equal(isValidPin("123"), false);
  assert.equal(isValidPin("12a4"), false);
});

test("session tokens are random and stored only as hashes", () => {
  const a = newToken();
  const b = newToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40);
  assert.equal(tokenHash(a).length, 64);
  assert.notEqual(tokenHash(a), a);
});
