/* Passkey registration/login over HTTP with a real software authenticator (spec §7 "Registration", §8). */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { webauthnCredentialsPayments, webauthnCredentialsRules } from "../../src/db/schema.ts";
import { useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { SoftAuthenticator } from "../helpers/webauthn.ts";

const t = useTestDb();
const app = useTestApp();

async function register(auth: SoftAuthenticator, client: "web" | "native" = "native") {
  const opt = await app().inject({ method: "POST", url: "/api/auth/register/options", payload: { displayName: "Dana" } });
  expect(opt.statusCode).toBe(200);
  const { challengeId, options } = opt.json();
  return app().inject({
    method: "POST",
    url: "/api/auth/register/verify",
    payload: { challengeId, response: auth.register(options.challenge), client },
  });
}

describe("auth", () => {
  beforeEach(async () => {
    await t.reset();
  });

  it("registration writes the credential to BOTH tables and returns native tokens", async () => {
    const auth = new SoftAuthenticator();
    const res = await register(auth);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.onboarded).toBe(false);
    expect(body.tokens.accessToken).toBeTruthy();
    const r = await getDb().select().from(webauthnCredentialsRules).where(eq(webauthnCredentialsRules.credentialId, auth.id));
    const p = await getDb().select().from(webauthnCredentialsPayments).where(eq(webauthnCredentialsPayments.credentialId, auth.id));
    expect(r).toHaveLength(1);
    expect(p).toHaveLength(1);
    expect(r[0]!.publicKey).toBe(p[0]!.publicKey);
    const me = await app().inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${body.tokens.accessToken}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().displayName).toBe("Dana");
  });

  it("web registration sets an httpOnly cookie instead of tokens", async () => {
    const res = await register(new SoftAuthenticator(), "web");
    expect(res.json().tokens).toBeNull();
    const cookie = res.cookies.find((c) => c.name === "kassa_session");
    expect(cookie?.httpOnly).toBe(true);
    const me = await app().inject({ method: "GET", url: "/api/me", cookies: { kassa_session: cookie!.value } });
    expect(me.statusCode).toBe(200);
  });

  it("a registration challenge is single use", async () => {
    const auth = new SoftAuthenticator();
    const opt = (await app().inject({ method: "POST", url: "/api/auth/register/options", payload: { displayName: "D" } })).json();
    const payload = { challengeId: opt.challengeId, response: auth.register(opt.options.challenge), client: "native" };
    expect((await app().inject({ method: "POST", url: "/api/auth/register/verify", payload })).statusCode).toBe(200);
    const again = await app().inject({ method: "POST", url: "/api/auth/register/verify", payload });
    expect(again.statusCode).toBe(400);
    expect(again.headers["content-type"]).toContain("application/problem+json");
  });

  it("login verifies the assertion; wrong origin and missing UV are rejected", async () => {
    const auth = new SoftAuthenticator({ counter: 1 });
    await register(auth);
    const login = async (opts: Parameters<SoftAuthenticator["assert"]>[1] = {}) => {
      const o = (await app().inject({ method: "POST", url: "/api/auth/login/options" })).json();
      return app().inject({
        method: "POST",
        url: "/api/auth/login/verify",
        payload: { challengeId: o.challengeId, response: auth.assert(o.options.challenge, opts), client: "native" },
      });
    };
    expect((await login()).statusCode).toBe(200);
    expect((await login({ origin: "https://evil.example" })).statusCode).toBe(401);
    expect((await login({ uv: false })).statusCode).toBe(401);
    expect((await login({ counter: 1 })).statusCode).toBe(401); // counter went backwards
  });

  it("refresh tokens rotate and cannot be reused", async () => {
    const res = (await register(new SoftAuthenticator())).json();
    const r1 = await app().inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken: res.tokens.refreshToken } });
    expect(r1.statusCode).toBe(200);
    const r2 = await app().inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken: res.tokens.refreshToken } });
    expect(r2.statusCode).toBe(401);
  });

  it("unauthenticated calls get RFC 9457 problem+json 401", async () => {
    const res = await app().inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json()).toMatchObject({ status: 401, code: "UNAUTHENTICATED", title: "Unauthorized" });
  });
});
