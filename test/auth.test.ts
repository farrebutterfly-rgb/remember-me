import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { TokenSigner, hashPassword, verifyPassword } from "../src/auth.ts";

test("passwords are checked against a salted scrypt hash", () => {
  const { salt, hash } = hashPassword("alice-test-pass");
  assert.equal(verifyPassword("alice-test-pass", salt, hash), true);
  assert.equal(verifyPassword("alice-test-pas", salt, hash), false);
});

test("a token verifies only with the secret that signed it", () => {
  const s1 = TokenSigner.random();
  const s2 = TokenSigner.random();
  const { token } = s1.issue("usr_alice");
  const v = s1.verify(token);
  assert.equal(v.ok && v.payload.sub, "usr_alice");
  assert.deepEqual(s2.verify(token), { ok: false, reason: "bad_signature" });
});

test("changing the user id inside the payload breaks the signature", () => {
  const s = TokenSigner.random();
  const [p, body, sig] = s.issue("usr_bob").token.split(".");
  const payload = JSON.parse(Buffer.from(body!, "base64url").toString());
  payload.sub = "usr_alice";
  const forged = [p, Buffer.from(JSON.stringify(payload)).toString("base64url"), sig].join(".");
  assert.deepEqual(s.verify(forged), { ok: false, reason: "bad_signature" });
});

test("expired and malformed tokens are rejected", () => {
  let now = 1_000_000;
  const s = new TokenSigner(randomBytes(32), 60, () => now);
  const { token } = s.issue("usr_alice");
  now += 61;
  assert.deepEqual(s.verify(token), { ok: false, reason: "expired" });
  assert.deepEqual(s.verify("usr_alice"), { ok: false, reason: "malformed" });
  assert.deepEqual(s.verify("rmt1..x"), { ok: false, reason: "malformed" });
});
