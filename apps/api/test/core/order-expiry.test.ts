/*
 * X8 (p2 B3): approving an expired order must never silently re-issue and sign a new canonical order. The approve
 * call answers 410 ORDER_EXPIRED and returns the RE-ISSUED order (new nonce/expiry/hash) for the user to review;
 * nothing is signed or executed in that call. A GET that re-issues says so (reissuedFromOrderHash).
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { approvals, payments, proposals } from "../../src/db/schema.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { setSanctionsListForTests } from "../../src/modules/screening/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { addPayee, createUserWithPasskey, IBAN_UNIVERSITY, offlineEnvironment } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();
const app = useTestApp();

async function pendingOrder() {
  const { userId, auth } = await createUserWithPasskey({ preset: "ASK_ME" });
  const payee = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY });
  const r = await proposeOrder({ userId, createdBy: "USER", payeeId: payee.id, amountMinor: 9_600, currency: "EUR", purpose: "Library fee" });
  expect(r.decision).toBe("ASK");
  return { userId, auth, proposalId: r.proposalId };
}

describe("X8 expired orders are re-issued for review, never signed in the same call", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setSanctionsListForTests([]);
    clock.setOffsetInMemoryForTests(0);
  });

  it("approve after expiry → 410 ORDER_EXPIRED + the re-issued order; nothing signed or executed", async () => {
    const { userId, auth, proposalId } = await pendingOrder();
    const v1 = await getOrderView(userId, proposalId);
    clock.setOffsetInMemoryForTests(11 * 60_000);
    const res = await app().inject({ method: "POST", url: `/api/orders/${proposalId}/approve`, headers: await bearer(userId), payload: { assertion: auth.assert(v1.orderHash) } });
    expect(res.statusCode).toBe(410);
    const body = res.json();
    expect(body.code).toBe("ORDER_EXPIRED");
    const reissued = body.details;
    expect(reissued.reissuedFromOrderHash).toBe(v1.orderHash);
    expect(reissued.orderHash).not.toBe(v1.orderHash);
    expect(reissued.canonicalOrder.nonce).not.toBe(v1.canonicalOrder.nonce);
    expect(reissued.canonicalOrder).toMatchObject({ amountMinor: 9_600, currency: "EUR", payeeId: v1.canonicalOrder.payeeId });
    expect(reissued.webauthnOptions.challenge).toBe(reissued.orderHash);

    expect(await getDb().select().from(approvals)).toHaveLength(0);
    expect(await getDb().select().from(payments)).toHaveLength(0);
    const row = (await getDb().select().from(proposals).where(eq(proposals.id, proposalId)))[0]!;
    expect(row.status).toBe("PENDING_APPROVAL");
    expect(row.orderHash).toBe(reissued.orderHash);

    // The user reviews the new order and signs IT: only then is it approved.
    const ok = await approveOrder(userId, proposalId, auth.assert(reissued.orderHash));
    expect(ok.tier).toBe("T2");
    expect(ok.paymentStatus).toBe("PROCESSING");
  });

  it("the old assertion cannot approve the re-issued order", async () => {
    const { userId, auth, proposalId } = await pendingOrder();
    const v1 = await getOrderView(userId, proposalId);
    const oldAssertion = auth.assert(v1.orderHash);
    clock.setOffsetInMemoryForTests(11 * 60_000);
    await expect(approveOrder(userId, proposalId, oldAssertion)).rejects.toMatchObject({ status: 410, code: "ORDER_EXPIRED" });
    await expect(approveOrder(userId, proposalId, auth.assert(v1.orderHash))).rejects.toMatchObject({ status: 403 });
    expect(await getDb().select().from(approvals)).toHaveLength(0);
  });

  it("a GET that re-issues an expired order says so (reissuedFromOrderHash); a fresh GET does not", async () => {
    const { userId, proposalId } = await pendingOrder();
    const v1 = await getOrderView(userId, proposalId);
    expect(v1.reissuedFromOrderHash).toBeUndefined();
    clock.setOffsetInMemoryForTests(11 * 60_000);
    const v2 = await getOrderView(userId, proposalId);
    expect(v2.reissuedFromOrderHash).toBe(v1.orderHash);
    expect(v2.orderHash).not.toBe(v1.orderHash);
    expect((await getOrderView(userId, proposalId)).reissuedFromOrderHash).toBeUndefined();
  });
});
