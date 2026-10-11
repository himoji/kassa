/*
 * X4 (security review F6, p3 B1): sanctions screening ran only for bank transfers, so a MERCHANT payee with a listed
 * name went through CARD_ISSUING (a one-time card was issued). Screening (I9) now runs at payee creation and on every
 * rail at decide (rules step 4) and at payment (payments step 7): card, handoff, pay-in-place and bank.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { ledgerEntries, payees, payments } from "../../src/db/schema.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { executeApproval } from "../../src/modules/payments/index.ts";
import { approveOrder, getOrderView, proposeOrder, registerExecutor } from "../../src/modules/rules/index.ts";
import { loadSanctions, setSanctionsListForTests } from "../../src/modules/screening/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { addPayee, createUserWithPasskey, IBAN_OTHER, offlineEnvironment } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();
const app = useTestApp();
const LISTED = "Northwind Arms Trading OOO"; // fixtures/sanctions-sample.json entity

describe("X4 screening on every rail", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setSanctionsListForTests(loadSanctions());
    clock.setOffsetInMemoryForTests(0);
  });

  it.each([
    ["CARD_ISSUING (merchant, capped wallet)", { moneyMode: "CAPPED_WALLET" as const }, "MERCHANT" as const, undefined],
    ["PAY_IN_PLACE (merchant, pay-in-place mode)", { moneyMode: "PAY_IN_PLACE" as const }, "MERCHANT" as const, undefined],
    ["HANDOFF (region CN)", { region: "CN" as const }, "MERCHANT" as const, undefined],
    ["HANDOFF (money mode)", { moneyMode: "HANDOFF" as const }, "SUPPLIER" as const, undefined],
    ["BANK_TRANSFER", {}, "PERSON" as const, "BANK_TRANSFER" as const],
  ])("rules: a listed payee name on %s → REFUSE_SANCTIONS, nothing to sign", async (_label, user, kind, rail) => {
    const { userId } = await createUserWithPasskey(user);
    const payee = await addPayee(userId, { name: LISTED, kind, account: IBAN_OTHER }); // existed before the list update
    const r = await proposeOrder({ userId, createdBy: "AGENT", payeeId: payee.id, amountMinor: 500_000, currency: "HUF", purpose: "order", ...(rail ? { rail } : {}) });
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toEqual(["REFUSE_SANCTIONS"]);
    expect(await getDb().select().from(payments)).toHaveLength(0);
  });

  it("payments: a card order approved before the list update is refused at payment (no card issued)", async () => {
    const { userId, auth } = await createUserWithPasskey({ moneyMode: "CAPPED_WALLET" });
    const payee = await addPayee(userId, { name: LISTED, kind: "MERCHANT", account: IBAN_OTHER });
    setSanctionsListForTests([]);
    const r = await proposeOrder({ userId, createdBy: "USER", payeeId: payee.id, amountMinor: 5_000_000, currency: "HUF", purpose: "order" });
    expect(r.decision).toBe("ASK");
    const v = await getOrderView(userId, r.proposalId);
    expect(v.canonicalOrder.rail).toBe("CARD_ISSUING");
    registerExecutor(null);
    const res = await approveOrder(userId, r.proposalId, auth.assert(v.orderHash));
    offlineEnvironment();
    setSanctionsListForTests(loadSanctions());
    expect((await executeApproval(res.approvalId)).reasonCodes).toEqual(["REFUSE_SANCTIONS"]);
    expect(await getDb().select().from(payments)).toHaveLength(0);
  });

  it("payee creation: a listed name is refused (422 REFUSE_SANCTIONS), not stored, and the hit is ledgered", async () => {
    const { userId } = await createUserWithPasskey();
    const res = await app().inject({
      method: "POST",
      url: "/api/payees",
      headers: await bearer(userId),
      payload: { name: "Svyatoslav Kassov", kind: "MERCHANT", account: "kassov shop", country: "HU", currency: "HUF" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("REFUSE_SANCTIONS");
    expect(await getDb().select().from(payees).where(eq(payees.userId, userId))).toHaveLength(0);
    const hit = (await getDb().select().from(ledgerEntries)).filter((e) => e.type === "PAYEE_SCREENING_HIT");
    expect(hit).toHaveLength(1);
    expect(JSON.stringify(hit[0]!.payload)).not.toContain("Kassov"); // the name is sealed with the user's key
  });

  it("payee creation: an ordinary name is created COOLING as before", async () => {
    const { userId } = await createUserWithPasskey();
    const res = await app().inject({
      method: "POST",
      url: "/api/payees",
      headers: await bearer(userId),
      payload: { name: "Pizza Shop in Budapest", kind: "MERCHANT", account: "pizza shop", country: "HU", currency: "HUF" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("COOLING");
  });
});
