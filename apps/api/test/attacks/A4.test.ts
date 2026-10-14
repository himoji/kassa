/*
 * A4 — loosen a cap without a passkey; loosen the preset with a passkey before 24 h.
 * Expected: without passkey → rejected (428 PASSKEY_REQUIRED, nothing stored or applied);
 * a raised cap with the passkey → applied at once (limits need the passkey, no waiting: DECISIONS);
 * a preset loosening with the passkey → pending until effectiveAt (+24 h on the demo clock), then applied by the
 * scheduler. Tightening applies instantly (I8).
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { ledgerEntries, payments, profiles, ruleChanges, users } from "../../src/db/schema.ts";
import { setEnvForTests } from "../../src/env.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { proposeOrder } from "../../src/modules/rules/index.ts";
import { applyDueRuleChanges } from "../../src/modules/users/settings.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { addPayee, createUserWithPasskey, offlineEnvironment } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";
import { ledgerOf, ledgerWithReason, moneyMoved, recordGuarded } from "../helpers/attacks.ts";

const t = useTestDb();
const app = useTestApp();

async function caps(userId: string) {
  return (await getDb().select().from(profiles).where(eq(profiles.userId, userId)))[0]!.caps!;
}

describe("A4: loosening needs the passkey, tightening is instant", () => {
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
    expect(await ledgerOf("AUTH_ASSERTION_FAILED")).toHaveLength(1);
    expect(await moneyMoved()).toEqual({ livePayments: 0, sentPayments: 0, kassaTransactions: 0 });
    recordGuarded("A4", { case: "cap raise without passkey (428) and with a forged assertion (403)", outcome: "BLOCKED", decision: null, reasonCodes: ["PASSKEY_REQUIRED"], ledger: ["AUTH_ASSERTION_FAILED"] });
  });

  it("a raised cap with a passkey applies at once", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const before = await caps(userId);
    const body = { caps: { perPaymentMinor: before.perPaymentMinor * 2 } };
    const first = await app().inject({ method: "PATCH", url: "/api/settings", headers: await bearer(userId), payload: body });
    expect(first.statusCode).toBe(428);
    const { challengeId, webauthnOptions } = first.json().details;
    const signed = await app().inject({
      method: "PATCH",
      url: "/api/settings",
      headers: await bearer(userId),
      payload: { ...body, challengeId, assertion: auth.assert(webauthnOptions.challenge) },
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json().pending).toEqual([]);
    expect((await caps(userId)).perPaymentMinor).toBe(before.perPaymentMinor * 2);
    expect(await ledgerOf("RULES_LOOSENED")).toHaveLength(1);
    expect((await getDb().select().from(ruleChanges))[0]).toMatchObject({ direction: "LOOSEN", appliedAt: expect.any(Date) });
  });

  it("a preset loosening with a passkey: pending for 24 h, then applied", async () => {
    const { userId, auth } = await createUserWithPasskey({ preset: "ASK_ME" });
    const preset = async () => (await getDb().select().from(users).where(eq(users.id, userId)))[0]!.preset;
    const body = { preset: "SMART" };
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
    expect(await ledgerOf("RULES_LOOSEN_PENDING")).toHaveLength(1);
    expect(Date.parse(pending[0].effectiveAt) - clock.nowMs()).toBeGreaterThan(23.9 * 3_600_000);
    expect(await preset()).toBe("ASK_ME"); // not yet

    clock.setOffsetInMemoryForTests(23 * 3_600_000);
    expect(await applyDueRuleChanges()).toBe(0);
    expect(await preset()).toBe("ASK_ME");

    clock.setOffsetInMemoryForTests(24 * 3_600_000 + 1000);
    expect(await applyDueRuleChanges()).toBe(1);
    expect(await preset()).toBe("SMART");
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

  it("a raised per-payment cap counts only once signed: the same order is refused before, allowed right after", async () => {
    offlineEnvironment();
    const { userId, auth } = await createUserWithPasskey();
    const payee = await addPayee(userId, { name: "Landlord in Budapest", kind: "LANDLORD", currency: "KZT" });
    const before = await caps(userId);
    const body = { caps: { perPaymentMinor: before.perPaymentMinor * 10, perDayMinor: before.perDayMinor * 10, perMonthMinor: before.perMonthMinor * 10 } };
    const first = await app().inject({ method: "PATCH", url: "/api/settings", headers: await bearer(userId), payload: body });
    expect(first.statusCode).toBe(428);
    expect(await caps(userId)).toEqual(before);

    // 2.5x the old per-payment cap: refused (a cap is a hard limit under every preset). The signed change raises the
    // per-payment, daily and monthly caps, so after it no cap check applies.
    const amountMinor = (before.perPaymentMinor * 5) / 2;
    const early = await proposeOrder({ userId, createdBy: "AGENT", payeeId: payee.id, amountMinor, currency: "KZT", purpose: "rent" });
    expect(early.decision).toBe("REFUSE");
    expect(early.reasonCodes).toEqual(["REFUSE_CAP"]);
    expect(await ledgerWithReason("PROPOSAL_CREATED", "REFUSE_CAP")).toHaveLength(1);
    expect(await getDb().select().from(payments)).toHaveLength(0);
    expect(await moneyMoved()).toEqual({ livePayments: 0, sentPayments: 0, kassaTransactions: 0 });
    recordGuarded("A4", { case: "cap raise not signed with the passkey: order still refused", outcome: "BLOCKED", decision: "REFUSE", reasonCodes: ["REFUSE_CAP"], ledger: ["PROPOSAL_CREATED"] });

    const { challengeId, webauthnOptions } = first.json().details;
    const signed = await app().inject({
      method: "PATCH",
      url: "/api/settings",
      headers: await bearer(userId),
      payload: { ...body, challengeId, assertion: auth.assert(webauthnOptions.challenge) },
    });
    expect(signed.statusCode).toBe(200);
    expect((await caps(userId)).perPaymentMinor).toBe(before.perPaymentMinor * 10);
    // X2: ₸3.75M is above payments' own daily cap (₸2M), so rules now refuse it before signing; raise that
    // independent cap for this step, which is only about the rules cap loosening (I8).
    setEnvForTests({ PAYMENTS_DAILY_CAP_HOME_MINOR: "1000000000" });
    try {
      const late = await proposeOrder({ userId, createdBy: "AGENT", payeeId: payee.id, amountMinor, currency: "KZT", purpose: "rent" });
      expect(late.reasonCodes).not.toContain("REFUSE_CAP");
      expect(late.decision).toBe("ASK");
    } finally {
      setEnvForTests({ PAYMENTS_DAILY_CAP_HOME_MINOR: "200000000" });
    }
  });

  it("freeze is instant and refuses new orders", async () => {
    const { userId } = await createUserWithPasskey();
    const res = await app().inject({ method: "POST", url: "/api/freeze", headers: await bearer(userId) });
    expect(res.statusCode).toBe(200);
    expect((await getDb().select().from(users).where(eq(users.id, userId)))[0]!.frozenAt).not.toBeNull();
  });
});
