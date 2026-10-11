/*
 * X2 (security review F3, p3 O1): payments' own daily cap (I5) is the sum of the day's live payments in the
 * user's HOME currency across all currencies, converted by payments itself through an injected fx port (it does
 * not trust the order's homeAmountMinor). Rules pre-check the same usage so the user is refused before signing.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { payments, proposals } from "../../src/db/schema.ts";
import { setEnvForTests } from "../../src/env.ts";
import { executeApproval, registerHomeConverter } from "../../src/modules/payments/index.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { setSanctionsListForTests } from "../../src/modules/screening/index.ts";
import { addPayee, createUserWithPasskey, IBAN_UNIVERSITY, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { forgeSignedApproval } from "../helpers/forge.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();

describe("X2 payments daily cap in the home currency", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setSanctionsListForTests([]);
    setEnvForTests({ PAYMENTS_DAILY_CAP_HOME_MINOR: "150000000" }); // ₸1.5M
  });
  afterEach(() => setEnvForTests({ PAYMENTS_DAILY_CAP_HOME_MINOR: "200000000" }));

  it("converts the order itself: an order whose signed homeAmountMinor is understated is still refused", async () => {
    const { userId, auth } = await createUserWithPasskey();
    await signBaseRules(userId, auth);
    const university = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY });
    // €3,000 ≈ ₸1.68M (> ₸1.5M), but the (buggy) order claims ₸1; the user did sign it (T2).
    const { approvalId } = await forgeSignedApproval(university, { amountMinor: 300_000, currency: "EUR", homeAmountMinor: 1, tier: "T2", sign: (h) => auth.assert(h) });
    const res = await executeApproval(approvalId);
    expect(res.reasonCodes).toEqual(["PAYMENTS_DAILY_CAP"]);
    expect(await getDb().select().from(payments)).toHaveLength(0);
  });

  it("checks the signed small-auto limit against its own conversion, not the order's homeAmountMinor", async () => {
    const { userId, auth } = await createUserWithPasskey();
    await signBaseRules(userId, auth); // small-auto limit ₸10,000
    const shop = await addPayee(userId, { name: "Pizza Shop in Budapest", kind: "MERCHANT", currency: "HUF" });
    // HUF 50,000 ≈ ₸72,000, claimed as ₸5,000 by a buggy T1 small-auto approval.
    const { approvalId } = await forgeSignedApproval(shop, { amountMinor: 5_000_000, currency: "HUF", homeAmountMinor: 500_000 });
    expect((await executeApproval(approvalId)).reasonCodes).toEqual(["MANDATE_OUT_OF_SCOPE"]);
    expect(await getDb().select().from(payments)).toHaveLength(0);
  });

  it("fails closed when no fx port is wired (cannot evaluate the cap → refused)", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const university = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY });
    const r = await proposeOrder({ userId, createdBy: "USER", payeeId: university.id, amountMinor: 10_000, currency: "EUR", purpose: "Fee" });
    const v = await getOrderView(userId, r.proposalId);
    registerHomeConverter(null);
    try {
      const res = await approveOrder(userId, r.proposalId, auth.assert(v.orderHash));
      expect(res.reasonCodes).toEqual(["PAYMENTS_DAILY_CAP"]);
      expect(await getDb().select().from(payments)).toHaveLength(0);
    } finally {
      offlineEnvironment();
    }
  });

  it("rules pre-check payments' daily usage: the user gets REFUSE_CAP before signing, not a refusal after", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const university = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY });
    const landlord = await addPayee(userId, { name: "Landlord in Budapest", kind: "LANDLORD", currency: "HUF" });
    const first = await proposeOrder({ userId, createdBy: "USER", payeeId: university.id, amountMinor: 240_000, currency: "EUR", purpose: "Tuition" }); // ≈ ₸1.344M
    const v1 = await getOrderView(userId, first.proposalId);
    expect((await approveOrder(userId, first.proposalId, auth.assert(v1.orderHash))).paymentStatus).toBe("PROCESSING");
    // HUF 180,000 ≈ ₸259,200 → ₸1.6M today > ₸1.5M payments cap (the rules caps alone would only ASK).
    const second = await proposeOrder({ userId, createdBy: "USER", payeeId: landlord.id, amountMinor: 18_000_000, currency: "HUF", purpose: "Rent" });
    expect(second.decision).toBe("REFUSE");
    expect(second.reasonCodes).toEqual(["REFUSE_CAP", "PAYMENTS_DAILY_CAP"]);
    const row = (await getDb().select().from(proposals).where(eq(proposals.id, second.proposalId)))[0]!;
    expect(row.canonicalOrder).toBeNull(); // nothing to sign
    await expect(getOrderView(userId, second.proposalId)).rejects.toMatchObject({ status: 409 });
  });
});
