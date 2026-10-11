/*
 * A3 — direct call to the payments module without approval; also signature tamper and replay.
 * Expected: no payment, NO_APPROVAL / BAD_SIGNATURE / NONCE_USED, and a ledger entry each time.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { approvals, ledgerEntries, payments } from "../../src/db/schema.ts";
import { executeApproval } from "../../src/modules/payments/index.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { addPayee, createUserWithPasskey, IBAN_UNIVERSITY, offlineEnvironment } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();

async function refusals(code: string) {
  const rows = await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "PAYMENT_REFUSED"));
  return rows.filter((r) => (r.payload as { reasonCodes: string[] }).reasonCodes.includes(code));
}

describe("A3: payments without a valid approval", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  it("no approval at all → NO_APPROVAL, no payment, ledgered", async () => {
    const r = await executeApproval(randomUUID());
    expect(r.reasonCodes).toEqual(["NO_APPROVAL"]);
    expect(await getDb().select().from(payments)).toHaveLength(0);
    expect(await refusals("NO_APPROVAL")).toHaveLength(1);
  });

  it("forged approval row (attacker writes their own signature) → BAD_SIGNATURE", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const payee = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY });
    const p = await proposeOrder({ userId, createdBy: "AGENT", payeeId: payee.id, amountMinor: 10_000, currency: "EUR", purpose: "x" });
    const view = await getOrderView(userId, p.proposalId);
    const now = new Date();
    const forged = await getDb()
      .insert(approvals)
      .values({
        proposalId: p.proposalId,
        orderHash: view.orderHash,
        tier: "T2",
        approvalSig: Buffer.alloc(64, 7).toString("base64url"),
        keyId: "attacker",
        userAssertion: auth.assert(view.orderHash) as never,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      })
      .returning();
    const r = await executeApproval(forged[0]!.id);
    expect(r.reasonCodes).toEqual(["BAD_SIGNATURE"]);
    expect(await getDb().select().from(payments)).toHaveLength(0);
    expect(await refusals("BAD_SIGNATURE")).toHaveLength(1);
  });

  it("replaying an executed approval → NONCE_USED, still one payment", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const payee = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY });
    const p = await proposeOrder({ userId, createdBy: "AGENT", payeeId: payee.id, amountMinor: 10_000, currency: "EUR", purpose: "x" });
    const view = await getOrderView(userId, p.proposalId);
    const res = await approveOrder(userId, p.proposalId, auth.assert(view.orderHash));
    expect(res.paymentStatus).toBe("PROCESSING");
    const replay = await executeApproval(res.approvalId);
    expect(replay.reasonCodes).toEqual(["NONCE_USED"]);
    expect(await getDb().select().from(payments)).toHaveLength(1);
    expect(await refusals("NONCE_USED")).toHaveLength(1);
  });

  it("re-approving the same order with a replayed assertion is refused by rules", async () => {
    const { userId, auth } = await createUserWithPasskey({ counter: 5 });
    const payee = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY });
    const p = await proposeOrder({ userId, createdBy: "AGENT", payeeId: payee.id, amountMinor: 10_000, currency: "EUR", purpose: "x" });
    const view = await getOrderView(userId, p.proposalId);
    const assertion = auth.assert(view.orderHash);
    await approveOrder(userId, p.proposalId, assertion);
    await expect(approveOrder(userId, p.proposalId, assertion)).rejects.toMatchObject({ code: "NOT_PENDING" });
  });
});
