/*
 * X5 (p3 B2): after POST /privacy/erase, /api/auth/refresh with the erased user's refresh token still returned 200
 * and a new access token. Erasure now revokes every refresh token of the user, and refresh applies the same account
 * checks as login (user exists, not erased) — GDPR Art. 17, OWASP ASVS 3.3.1 (logout/invalidation), RFC 9700 §4.14.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { SoftAuthenticator } from "../helpers/webauthn.ts";

const t = useTestDb();
const app = useTestApp();

async function registerNative(auth: SoftAuthenticator) {
  const opt = (await app().inject({ method: "POST", url: "/api/auth/register/options", payload: { displayName: "Mallory" } })).json();
  const res = await app().inject({ method: "POST", url: "/api/auth/register/verify", payload: { challengeId: opt.challengeId, response: auth.register(opt.options.challenge), client: "native" } });
  expect(res.statusCode).toBe(200);
  return res.json().tokens as { accessToken: string; refreshToken: string };
}

async function loginNative(auth: SoftAuthenticator) {
  const o = (await app().inject({ method: "POST", url: "/api/auth/login/options" })).json();
  const res = await app().inject({ method: "POST", url: "/api/auth/login/verify", payload: { challengeId: o.challengeId, response: auth.assert(o.options.challenge), client: "native" } });
  expect(res.statusCode).toBe(200);
  return res.json().tokens as { accessToken: string; refreshToken: string };
}

async function erase(accessToken: string, auth: SoftAuthenticator) {
  const h = { authorization: `Bearer ${accessToken}` };
  const first = await app().inject({ method: "POST", url: "/api/privacy/erase", headers: h, payload: { confirm: "ERASE" } });
  expect(first.statusCode).toBe(428);
  const d = first.json().details as { challengeId: string; webauthnOptions: { challenge: string } };
  const res = await app().inject({ method: "POST", url: "/api/privacy/erase", headers: h, payload: { confirm: "ERASE", challengeId: d.challengeId, assertion: auth.assert(d.webauthnOptions.challenge) } });
  expect(res.statusCode).toBe(200);
}

const refresh = (refreshToken: string) => app().inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken } });

describe("X5 erase revokes refresh tokens", () => {
  beforeEach(async () => {
    await t.reset();
  });

  it("every refresh token of an erased user (two devices/sessions) is refused with 401 ACCOUNT_ERASED", async () => {
    const auth = new SoftAuthenticator();
    const deviceA = await registerNative(auth);
    const deviceB = await loginNative(auth);
    await erase(deviceB.accessToken, auth);
    for (const token of [deviceA.refreshToken, deviceB.refreshToken]) {
      const r = await refresh(token);
      expect(r.statusCode).toBe(401);
      expect(r.json().code).toBe("ACCOUNT_ERASED");
      expect(r.json().accessToken).toBeUndefined();
    }
  });

  it("a refresh token rotated just before erasure is refused too (no new access token after erase)", async () => {
    const auth = new SoftAuthenticator();
    const first = await registerNative(auth);
    const rotated = (await refresh(first.refreshToken)).json() as { accessToken: string; refreshToken: string };
    await erase(rotated.accessToken, auth);
    expect((await refresh(rotated.refreshToken)).statusCode).toBe(401);
  });

  it("refresh still works for a normal user (control)", async () => {
    const auth = new SoftAuthenticator();
    const tokens = await registerNative(auth);
    const r = await refresh(tokens.refreshToken);
    expect(r.statusCode).toBe(200);
    expect(r.json().accessToken).toEqual(expect.any(String));
  });
});
