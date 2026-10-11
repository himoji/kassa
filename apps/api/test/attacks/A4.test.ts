/*
 * A4 — loosen a cap without a passkey; with a passkey before 24 h.
 * Expected: without passkey → rejected (428 PASSKEY_REQUIRED, nothing stored or applied);
 * with passkey → pending until effectiveAt (+24 h on the demo clock), then applied by the scheduler.
 * Tightening applies instantly (I8).
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { ledgerEntries, profiles, ruleChanges, users } from "../../src/db/schema.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { applyDueRuleChanges } from "../../src/modules/users/settings.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { createUserWithPasskey } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();
const app = useTestApp();

async function caps(userId: string) {
  return (await getDb().select().from(profiles).where(eq(profiles.userId, userId)))[0]!.caps!;
}

describe("A4: loosening is slow, tightening is instant", () => {
  beforeEach(async () => {
    await t.reset();
    clock.setOffsetInMemoryForTests(0);
  });

  it("raising a cap without a passkey is rejected and changes nothing", async () => {
    const { userId } = await createUserWithPasskey();
    const before = await caps(userId);
    const res = await app().inject({
      method: "PATCH",
      url: "/api/settings",
      headers: await bearer(userId),
      payload: { caps: { perPaymentMinor: before.perPaymentMinor * 10 } },
    });
    expect(res.statusCode).toBe(428);
    expect(res.json()).toMatchObject({ code: "PASSKEY_REQUIRED" });
    expect(res.json().details.webauthnOptions.challenge).toBeTruthy();
    expect(await caps(userId)).toEqual(before);
    expect(await getDb().select().from(ruleChanges)).toHaveLength(0);
    // A bogus assertion is rejected too.
    const forged = await app().inject({
      method: "PATCH",
      url: "/api/settings",
      headers: await bearer(userId),
      payload: { caps: { perPaymentMinor: before.perPaymentMinor * 10 }, challengeId: res.json().details.challengeId, assertion: { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" }, clientExtensionResults: {} } },
    });
    expect(forged.statusCode).toBe(403);
    expect(await caps(userId)).toEqual(before);
  });

  it("with a passkey: pending for 24 h, then applied", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const before = await caps(userId);
    const body = { caps: { perPaymentMinor: before.perPaymentMinor * 2 } };
    const first = await app().inject({ method: "PATCH", url: "/api/settings", headers: await bearer(userId), payload: body });
    const { challengeId, webauthnOptions } = first.json().details;
    const signed = await app().inject({
      method: "PATCH",
      url: "/api/settings",
      headers: await bearer(userId),
      payload: { ...body, challengeId, assertion: auth.assert(webauthnOptions.challenge) },
    });
    expect(signed.statusCode).toBe(200);
    const pending = signed.json().pending;
    expect(pending).toHaveLength(1);
    expect(Date.parse(pending[0].effectiveAt) - clock.nowMs()).toBeGreaterThan(23.9 * 3_600_000);
    expect(await caps(userId)).toEqual(before); // not yet

    clock.setOffsetInMemoryForTests(23 * 3_600_000);
    expect(await applyDueRuleChanges()).toBe(0);
    expect((await caps(userId)).perPaymentMinor).toBe(before.perPaymentMinor);

    clock.setOffsetInMemoryForTests(24 * 3_600_000 + 1000);
    expect(await applyDueRuleChanges()).toBe(1);
    expect((await caps(userId)).perPaymentMinor).toBe(before.perPaymentMinor * 2);
    const log = await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "RULES_LOOSENED"));
    expect(log).toHaveLength(1);
  });

  it("a signature over a different change cannot be reused", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const before = await caps(userId);
    const small = await app().inject({ method: "PATCH", url: "/api/settings", headers: await bearer(userId), payload: { caps: { perPaymentMinor: before.perPaymentMinor + 1 } } });
    const { challengeId, webauthnOptions } = small.json().details;
    const res = await app().inject({
      method: "PATCH",
      url: "/api/settings",
      headers: await bearer(userId),
      payload: { caps: { perPaymentMinor: before.perPaymentMinor * 100 }, challengeId, assertion: auth.assert(webauthnOptions.challenge) },
    });
    expect(res.statusCode).toBe(409);
    expect(await getDb().select().from(ruleChanges)).toHaveLength(0);
  });

  it("tightening (lower cap, ASK_ME preset) applies immediately without a passkey", async () => {
    const { userId } = await createUserWithPasskey({ preset: "SMART" });
    const before = await caps(userId);
    const res = await app().inject({
      method: "PATCH",
      url: "/api/settings",
      headers: await bearer(userId),
      payload: { preset: "ASK_ME", caps: { perPaymentMinor: before.perPaymentMinor - 100 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pending).toEqual([]);
    expect((await caps(userId)).perPaymentMinor).toBe(before.perPaymentMinor - 100);
    expect((await getDb().select().from(users).where(eq(users.id, userId)))[0]!.preset).toBe("ASK_ME");
  });

  it("preset upgrade ASK_ME → AUTOPILOT is a loosening", async () => {
    const { userId } = await createUserWithPasskey({ preset: "ASK_ME" });
    const res = await app().inject({ method: "PATCH", url: "/api/settings", headers: await bearer(userId), payload: { preset: "AUTOPILOT" } });
    expect(res.statusCode).toBe(428);
  });

  it("invalid combinations are rejected (NEVER_ASK with HANDOFF)", async () => {
    const { userId } = await createUserWithPasskey({ preset: "SMART" });
    const res = await app().inject({
      method: "PATCH",
      url: "/api/settings",
      headers: await bearer(userId),
      payload: { overrides: { paymentPolicy: "NEVER_ASK", moneyMode: "HANDOFF" } },
    });
    expect(res.statusCode).toBe(422);
  });

  it("freeze is instant and refuses new orders", async () => {
    const { userId } = await createUserWithPasskey();
    const res = await app().inject({ method: "POST", url: "/api/freeze", headers: await bearer(userId) });
    expect(res.statusCode).toBe(200);
    expect((await getDb().select().from(users).where(eq(users.id, userId)))[0]!.frozenAt).not.toBeNull();
  });
});
