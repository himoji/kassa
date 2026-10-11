/*
 * X3 (security review F1): POST /payees/:id/verify-callback used to verify a cooled-down payee with a session
 * only, after which small-auto could pay it without any passkey. Verification now needs a FRESH passkey assertion
 * over a payee-verification challenge (PSD2 RTS Art. 5 dynamic linking: the challenge binds the payee id, name and
 * account hash), using the same 428 PASSKEY_REQUIRED round trip as other passkey-gated writes.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { ledgerEntries, payees } from "../../src/db/schema.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { createUserWithPasskey, IBAN_OTHER, offlineEnvironment } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();
const app = useTestApp();

async function coolingPayee(userId: string, name = "Corner Shop in Budapest") {
  const res = await app().inject({
    method: "POST",
    url: "/api/payees",
    headers: await bearer(userId),
    payload: { name, kind: "PERSON", account: IBAN_OTHER, country: "HU", currency: "HUF" },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; status: string };
}

async function payeeStatus(id: string) {
  return (await getDb().select().from(payees).where(eq(payees.id, id)))[0]!.status;
}

describe("X3 payee verify-callback needs a fresh passkey", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    clock.setOffsetInMemoryForTests(0);
  });

  it("session only → 428 PASSKEY_REQUIRED with a challenge bound to this payee; the payee stays COOLING", async () => {
    const { userId } = await createUserWithPasskey();
    const p = await coolingPayee(userId);
    clock.setOffsetInMemoryForTests(24 * 3_600_000 + 1000);
    const res = await app().inject({ method: "POST", url: `/api/payees/${p.id}/verify-callback`, headers: await bearer(userId) });
    expect(res.statusCode).toBe(428);
    const body = res.json();
    expect(body.code).toBe("PASSKEY_REQUIRED");
    expect(body.details.challengeId).toEqual(expect.any(String));
    expect(body.details.webauthnOptions.challenge).toEqual(expect.any(String));
    expect(await payeeStatus(p.id)).toBe("COOLING");
  });

  it("the signed challenge verifies the payee and the ledger records the signed challenge", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const p = await coolingPayee(userId);
    clock.setOffsetInMemoryForTests(24 * 3_600_000 + 1000);
    const h = await bearer(userId);
    const first = await app().inject({ method: "POST", url: `/api/payees/${p.id}/verify-callback`, headers: h });
    const { challengeId, webauthnOptions } = first.json().details;
    const ok = await app().inject({
      method: "POST",
      url: `/api/payees/${p.id}/verify-callback`,
      headers: h,
      payload: { challengeId, assertion: auth.assert(webauthnOptions.challenge) },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("VERIFIED");
    expect(await payeeStatus(p.id)).toBe("VERIFIED");
    // The ledger records which challenge (payee-bound core hash) the user signed.
    const entry = (await getDb().select().from(ledgerEntries)).find((e) => e.type === "PAYEE_VERIFIED")!;
    const payload = entry.payload as { challengeHash?: string };
    expect(payload.challengeHash).toBe(webauthnOptions.challenge);
  });

  it("an assertion over another challenge → 403, payee stays COOLING; the challenge is single use", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const p = await coolingPayee(userId);
    clock.setOffsetInMemoryForTests(24 * 3_600_000 + 1000);
    const h = await bearer(userId);
    const { challengeId } = (await app().inject({ method: "POST", url: `/api/payees/${p.id}/verify-callback`, headers: h })).json().details;
    const bad = await app().inject({ method: "POST", url: `/api/payees/${p.id}/verify-callback`, headers: h, payload: { challengeId, assertion: auth.assert("some-other-challenge") } });
    expect(bad.statusCode).toBe(403);
    expect(await payeeStatus(p.id)).toBe("COOLING");
    const reuse = await app().inject({ method: "POST", url: `/api/payees/${p.id}/verify-callback`, headers: h, payload: { challengeId, assertion: auth.assert("x") } });
    expect(reuse.statusCode).toBe(409);
  });

  it("a challenge issued for payee A cannot verify payee B", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const a = await coolingPayee(userId, "Payee A in Budapest");
    const b = await coolingPayee(userId, "Payee B in Budapest");
    clock.setOffsetInMemoryForTests(24 * 3_600_000 + 1000);
    const h = await bearer(userId);
    const { challengeId, webauthnOptions } = (await app().inject({ method: "POST", url: `/api/payees/${a.id}/verify-callback`, headers: h })).json().details;
    const cross = await app().inject({
      method: "POST",
      url: `/api/payees/${b.id}/verify-callback`,
      headers: h,
      payload: { challengeId, assertion: auth.assert(webauthnOptions.challenge) },
    });
    expect(cross.statusCode).toBe(409);
    expect(await payeeStatus(b.id)).toBe("COOLING");
  });

  it("still cooling → 409 PAYEE_COOLING before any challenge is issued", async () => {
    const { userId } = await createUserWithPasskey();
    const p = await coolingPayee(userId);
    const res = await app().inject({ method: "POST", url: `/api/payees/${p.id}/verify-callback`, headers: await bearer(userId) });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("PAYEE_COOLING");
  });
});
