import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * TEST AUTHENTICATION. Good enough to prove that the backend, not the client, decides who is
 * asking. Not a production auth system: no refresh tokens, no revocation list, no rate limiting,
 * no password reset, and the seeded users have published passwords.
 *
 * Token format: "rmt1.<base64url(json payload)>.<base64url(HMAC-SHA256(secret, 'rmt1.' + payload))>"
 * The user id lives only inside the signed payload. Nothing else in a request can name a user.
 */

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(password, salt, 32).toString("hex") };
}

export function verifyPassword(password: string, salt: string, hash: string): boolean {
  const got = scryptSync(password, salt, 32);
  const want = Buffer.from(hash, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface TokenPayload {
  sub: string; // user id
  sid: string; // session id, logged so a run can be tied to a login
  iat: number; // seconds
  exp: number; // seconds
}

export type VerifyResult = { ok: true; payload: TokenPayload } | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

const PREFIX = "rmt1";
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export class TokenSigner {
  constructor(private readonly secret: Buffer, private readonly ttlSeconds = 3600, private readonly now = () => Math.floor(Date.now() / 1000)) {
    if (secret.length < 32) throw new Error("token secret must be at least 32 bytes");
  }

  /** A fresh random secret: tokens die with the process. That is the default on purpose. */
  static random(ttlSeconds?: number) {
    return new TokenSigner(randomBytes(32), ttlSeconds);
  }

  private mac(body: string) {
    return createHmac("sha256", this.secret).update(`${PREFIX}.${body}`).digest();
  }

  issue(sub: string): { token: string; payload: TokenPayload } {
    const iat = this.now();
    const payload: TokenPayload = { sub, sid: randomBytes(6).toString("hex"), iat, exp: iat + this.ttlSeconds };
    const body = b64(JSON.stringify(payload));
    return { token: `${PREFIX}.${body}.${b64(this.mac(body))}`, payload };
  }

  verify(token: string): VerifyResult {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) return { ok: false, reason: "malformed" };
    const want = this.mac(parts[1]);
    const got = Buffer.from(parts[2], "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "bad_signature" };
    let payload: TokenPayload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as TokenPayload;
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return { ok: false, reason: "malformed" };
    if (payload.exp <= this.now()) return { ok: false, reason: "expired" };
    return { ok: true, payload };
  }
}
