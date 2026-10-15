/* I7 (payee change = new cooling payee) and I8 for mandates (create with passkey → +24 h; revoke instant). */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { mandates, payees } from "../../src/db/schema.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { activateDueMandates } from "../../src/modules/mandates/service.ts";
import { decryptAccount } from "../../src/modules/payees/crypto.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { addObligation, addPayee, createUserWithPasskey, IBAN_LANDLORD, IBAN_OTHER, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();
const app = useTestApp();

describe("payees (I7)", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    clock.setOffsetInMemoryForTests(0);
  });

  it("a new payee is COOLING for 24 h, encrypted at rest, and refused until then", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const res = await app().inject({
      method: "POST",
      url: "/api/payees",
      headers: await bearer(userId),
      payload: { name: "Landlord in Budapest", kind: "LANDLORD", account: "HU03 1620 0216 9011 7442 0000 0000", country: "HU", currency: "HUF" },
    });
    expect(res.statusCode).toBe(201);
    const dto = res.json();
    expect(dto.status).toBe("COOLING");
    expect(dto.accountMasked).toBe("HU •••• 0000");
    const row = (await getDb().select().from(payees).where(eq(payees.id, dto.id)))[0]!;
    expect(row.accountEnc).not.toContain("HU03");
    expect(decryptAccount(userId, row.accountEnc!, row.id)).toBe(IBAN_OTHER);
    expect(() => decryptAccount("00000000-0000-4000-8000-000000000000", row.accountEnc!, row.id)).toThrow(); // AAD binds the user

    const early = await proposeOrder({ userId, createdBy: "AGENT", payeeId: dto.id, amountMinor: 18_000_000, currency: "HUF", purpose: "Rent" });
    expect(early.decision).toBe("REFUSE");
    expect(early.reasonCodes).toEqual(["REFUSE_UNVERIFIED_PAYEE", "PAYEE_COOLING"]);
    expect((await app().inject({ method: "POST", url: `/api/payees/${dto.id}/verify-callback`, headers: await bearer(userId) })).statusCode).toBe(409);

    // After 24 h: usable in T2 only (never AUTO even with signed base rules and a small amount).
    clock.setOffsetInMemoryForTests(24 * 3_600_000 + 1000);
    await signBaseRules(userId, auth);
    const later = await proposeOrder({ userId, createdBy: "AGENT", payeeId: dto.id, amountMinor: 1000, currency: "HUF", purpose: "Rent" });
    expect(later.decision).toBe("ASK");
    expect(later.reasonCodes).toContain("PAYEE_COOLING");
    const v = await getOrderView(userId, later.proposalId);
    const paid = await approveOrder(userId, later.proposalId, auth.assert(v.orderHash));
    expect(paid.paymentStatus).toBe("PROCESSING");
  });

  it("an invalid IBAN is rejected (ISO 13616 / ISO 7064)", async () => {
    const { userId } = await createUserWithPasskey();
    const res = await app().inject({
      method: "POST",
      url: "/api/payees",
      headers: await bearer(userId),
      payload: { name: "X", kind: "PERSON", account: "HU04162002169011744200000000", country: "HU", currency: "HUF" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("A2-style account change creates a NEW cooling payee; the verified one is untouched", async () => {
    const { userId } = await createUserWithPasskey();
    const landlord = await addPayee(userId, { name: "Landlord in Budapest", account: IBAN_LANDLORD });
    const res = await app().inject({
      method: "POST",
      url: "/api/payees",
      headers: await bearer(userId),
      payload: { name: "Landlord in Budapest", kind: "LANDLORD", account: IBAN_OTHER, country: "HU", currency: "HUF", replacesPayeeId: landlord.id },
    });
    expect(res.json()).toMatchObject({ status: "COOLING", replacesPayeeId: landlord.id });
    const old = (await getDb().select().from(payees).where(eq(payees.id, landlord.id)))[0]!;
    expect(old.status).toBe("VERIFIED");
    expect(old.accountHash).toBe(landlord.accountHash);
  });
});

describe("mandates (I8)", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    clock.setOffsetInMemoryForTests(0);
  });

  it("create needs a passkey over mandateHash and becomes ACTIVE only after 24 h; revoke is instant", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const landlord = await addPayee(userId, { name: "Landlord in Budapest" });
    await signBaseRules(userId, auth);
    const h = await bearer(userId);
    const opt = await app().inject({
      method: "POST",
      url: "/api/mandates/options",
      headers: h,
      payload: { payeeIds: [landlord.id], categories: ["rent"], currency: "HUF", maxPerPaymentMinor: 20_000_000, maxPerPeriodMinor: 20_000_000, period: "MONTH", validUntil: null },
    });
    expect(opt.statusCode).toBe(200);
    const { core, mandateHash } = opt.json();
    expect(opt.json().webauthnOptions.challenge).toBe(mandateHash);

    const noSig = await app().inject({ method: "POST", url: "/api/mandates", headers: h, payload: { core, assertion: auth.assert("wrong-challenge") } });
    expect(noSig.statusCode).toBe(403);

    const created = await app().inject({ method: "POST", url: "/api/mandates", headers: h, payload: { core, assertion: auth.assert(mandateHash) } });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe("PENDING_EFFECTIVE");

    // X1: mandate payments are linked to a bill (one obligation per step, so each has its own unsettled period).
    const [billBefore, billAfter, billRevoked] = [await addObligation(userId, landlord.id), await addObligation(userId, landlord.id), await addObligation(userId, landlord.id, { amountMinor: 1_000_000 })];
    const before = await proposeOrder({ userId, createdBy: "SCHEDULER", payeeId: landlord.id, amountMinor: 18_000_000, currency: "HUF", purpose: "Rent", obligationId: billBefore.id });
    expect(before.decision).not.toBe("AUTO");

    clock.setOffsetInMemoryForTests(24 * 3_600_000 + 1000);
    expect(await activateDueMandates()).toBe(1);
    const after = await proposeOrder({ userId, createdBy: "SCHEDULER", payeeId: landlord.id, amountMinor: 18_000_000, currency: "HUF", purpose: "Rent", obligationId: billAfter.id });
    expect(after.decision).toBe("AUTO");

    // Access tokens are 15 min on the (advanced) Clock: mint a fresh one.
    const rev = await app().inject({ method: "POST", url: `/api/mandates/${core.mandateId}/revoke`, headers: await bearer(userId) });
    expect(rev.json().status).toBe("REVOKED");
    expect((await getDb().select().from(mandates).where(eq(mandates.id, core.mandateId)))[0]!.revokedAt).not.toBeNull();
    const revoked = await proposeOrder({ userId, createdBy: "SCHEDULER", payeeId: landlord.id, amountMinor: 1_000_000, currency: "HUF", purpose: "Rent", obligationId: billRevoked.id });
    expect(revoked.reasonCodes).not.toContain("MANDATE_MATCH");
  });
});
