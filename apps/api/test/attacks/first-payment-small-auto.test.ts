/*
 * A fooled planner that leaves `agentRequestedConfirm` off: the model's flag can only ADD an ask, so whether a small
 * order is paid without the passkey must not rest on it. A verified payee the user has never completed a payment to,
 * an amount under the signed small-auto limit, SMART preset, capped wallet: the rules still ASK
 * (FIRST_PAYMENT_TO_PAYEE, decide step 9), from a database fact the planner cannot set. Only after a completed payment
 * to that payee can small-auto apply.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { payments } from "../../src/db/schema.ts";
import { proposeOrder } from "../../src/modules/rules/index.ts";
import { setSanctionsListForTests } from "../../src/modules/screening/index.ts";
import { DEFAULT_CAPS } from "../../src/modules/users/service.ts";
import { addPayee, addPriorPayment, createUserWithPasskey, IBAN_OTHER, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();

describe("first payment to a payee is never small-auto (planner flag left off)", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setSanctionsListForTests([]);
  });

  it("verified payee, no history, under the small-auto limit, agentRequestedConfirm false → ASK, nothing paid", async () => {
    const { userId, auth } = await createUserWithPasskey({ preset: "SMART", moneyMode: "CAPPED_WALLET" });
    await signBaseRules(userId, auth);
    const payee = await addPayee(userId, { name: "Helpful Stranger", kind: "PERSON", account: IBAN_OTHER, currency: "KZT", status: "VERIFIED" });
    const amountMinor = DEFAULT_CAPS.smallAutoMinor / 2;
    const r = await proposeOrder({ userId, createdBy: "AGENT", payeeId: payee.id, amountMinor, currency: "KZT", purpose: "Quick favour", rail: "BANK_TRANSFER", agentRequestedConfirm: false });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("FIRST_PAYMENT_TO_PAYEE");
    expect(r.reasonCodes).not.toContain("SMALL_AUTO");
    expect(await getDb().select().from(payments)).toHaveLength(0);

    // The same order after one completed payment to that payee: small-auto applies (the rule is about history only).
    await addPriorPayment(userId, payee.id);
    const later = await proposeOrder({ userId, createdBy: "AGENT", payeeId: payee.id, amountMinor, currency: "KZT", purpose: "Quick favour again", rail: "BANK_TRANSFER", agentRequestedConfirm: false });
    expect(later.decision).toBe("AUTO");
    expect(later.reasonCodes).toEqual(["SMALL_AUTO"]);
  });
});
