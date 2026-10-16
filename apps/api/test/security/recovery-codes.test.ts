/*
 * Backup codes (auth/recovery.ts): minting needs the passkey; a code registers a new passkey that replaces every old
 * one, is single use, freezes payments and signs out sessions issued before the recovery.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { ledgerEntries, recoveryCodes, users, webauthnCredentialsPayments, webauthnCredentialsRules } from "../../src/db/schema.ts";
import { normalizeRecoveryCode } from "../../src/modules/auth/recovery.ts";
import { SoftAuthenticator } from "../../src/modules/auth/soft-authenticator.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

async function mintCodes(userId: string, auth: SoftAuthenticator): Promise<string[]> {
  const headers = await bearer(userId);
  const first = await app().inject({ method: "POST", url: "/api/auth/recovery-codes", headers, payload: {} });
  expect(first.statusCode).toBe(428);
  const { challengeId, webauthnOptions } = first.json().details as { challengeId: string; webauthnOptions: { challenge: string } };
  const signed = await app().inject({ method: "POST", url: "/api/auth/recovery-codes", headers, payload: { challengeId, assertion: auth.assert(webauthnOptions.challenge) } });
  expect(signed.statusCode).toBe(200);
  return (signed.json() as { codes: string[] }).codes;
}

async function recover(code: string, auth: SoftAuthenticator) {
  const opt = await app().inject({ method: "POST", url: "/api/auth/recovery/options", payload: { code } });
  if (opt.statusCode !== 200) return opt;
  const { challengeId, options } = opt.json() as { challengeId: string; options: { challenge: string } };
  return app().inject({ method: "POST", url: "/api/auth/recovery/verify", payload: { challengeId, response: auth.register(options.challenge), client: "native" } });
}

describe("backup codes", () => {
  beforeEach(async () => {
    await t.reset();
  });

  it("minting needs the passkey; a new set replaces the old one", async () => {
    const { userId, auth } = await createUserWithPasskey({ counter: 1 });
    const headers = await bearer(userId);
    const wrong = await app().inject({ method: "POST", url: "/api/auth/recovery-codes", headers, payload: {} });
    const { challengeId } = wrong.json().details as { challengeId: string };
    const other = new SoftAuthenticator();
    const forged = await app().inject({ method: "POST", url: "/api/auth/recovery-codes", headers, payload: { challengeId, assertion: other.assert("x") } });
    expect(forged.statusCode).toBe(403);

    const codes = await mintCodes(userId, auth);
    expect(codes).toHaveLength(10);
    expect(codes[0]).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    const stored = await getDb().select().from(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    expect(stored.map((r) => r.codeHash)).not.toContain(codes[0]);

    const status = await app().inject({ method: "GET", url: "/api/auth/recovery-codes", headers });
    expect(status.json()).toMatchObject({ remaining: 10, total: 10 });

    const again = await mintCodes(userId, auth);
    expect((await recover(codes[0]!, new SoftAuthenticator())).statusCode).toBe(401);
    expect(again[0]).not.toBe(codes[0]);
  });

  it("a code replaces every passkey, is single use, freezes payments and signs out old sessions", async () => {
    const { userId, auth } = await createUserWithPasskey({ counter: 1 });
    const codes = await mintCodes(userId, auth);
    const oldHeaders = await bearer(userId);
    // Sessions follow wall time (not the demo clock): step it past the old token's second.
    clock.freezeForTests(new Date(clock.realNowMs() + 2_000));

    const fresh = new SoftAuthenticator();
    // Typed by hand: lower case, spaces, an O for a 0 still works.
    const typed = codes[3]!.toLowerCase().replace("-", " ").replace(/0/g, "o");
    expect(normalizeRecoveryCode(typed)).toBe(codes[3]!.replace("-", ""));
    const res = await recover(typed, fresh);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { id: userId }, recovery: { codesLeft: 9, paymentsFrozen: true } });

    const rules = await getDb().select().from(webauthnCredentialsRules).where(eq(webauthnCredentialsRules.userId, userId));
    const pay = await getDb().select().from(webauthnCredentialsPayments).where(eq(webauthnCredentialsPayments.userId, userId));
    expect(rules.map((r) => r.credentialId)).toEqual([fresh.id]);
    expect(pay.map((r) => r.credentialId)).toEqual([fresh.id]);
    const u = (await getDb().select().from(users).where(eq(users.id, userId)))[0]!;
    expect(u.frozenAt).not.toBeNull();
    const types = (await getDb().select({ type: ledgerEntries.type }).from(ledgerEntries)).map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(["RECOVERY_CODES_CREATED", "ACCOUNT_FROZEN", "AUTH_ACCOUNT_RECOVERED"]));

    // Single use.
    expect((await recover(codes[3]!, new SoftAuthenticator())).statusCode).toBe(401);
    // The old session is signed out; the recovered one works.
    expect((await app().inject({ method: "GET", url: "/api/me", headers: oldHeaders })).statusCode).toBe(401);
    const token = (res.json() as { tokens: { accessToken: string } }).tokens.accessToken;
    expect((await app().inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    // The lost passkey can no longer sign in.
    const o = (await app().inject({ method: "POST", url: "/api/auth/login/options" })).json() as { challengeId: string; options: { challenge: string } };
    const login = await app().inject({ method: "POST", url: "/api/auth/login/verify", payload: { challengeId: o.challengeId, response: auth.assert(o.options.challenge), client: "native" } });
    expect(login.statusCode).toBe(401);
    clock.freezeForTests(null);
  });

  it("unknown codes are refused", async () => {
    expect((await recover("AAAAA-BBBBB", new SoftAuthenticator())).statusCode).toBe(401);
  });
});
