/*
 * Simulates a rules LOGIC bug (not a stolen key): inserts a canonical order + an approval correctly signed with the
 * rules key for an order rules should never have approved. Payments must refuse it on its own checks (I2).
 */
import { orderHash, type CanonicalOrder } from "@kassa/shared";
import { randomBytes, randomUUID } from "node:crypto";

import { getDb } from "../../src/db/client.ts";
import { approvals, proposals, type payees } from "../../src/db/schema.ts";
import { addMs, clock } from "../../src/modules/clock/index.ts";
import { APPROVAL_TTL_MS, signApproval } from "../../src/modules/rules/signing.ts";

export async function forgeSignedApproval(
  payee: typeof payees.$inferSelect,
  o: Partial<CanonicalOrder> & {
    amountMinor: number;
    currency: string;
    homeAmountMinor: number;
    tier?: "T1" | "T2";
    category?: string;
    /** T2: the user's passkey over the orderHash (e.g. `(h) => auth.assert(h)`). */
    sign?: (orderHash: string) => unknown;
  },
): Promise<{ approvalId: string; proposalId: string; order: CanonicalOrder }> {
  const now = clock.now();
  const proposalId = randomUUID();
  const { tier = "T1", category = "other", sign, ...fields } = o;
  const order: CanonicalOrder = {
    v: 1,
    proposalId,
    userId: payee.userId,
    payeeId: payee.id,
    payeeName: payee.name,
    payeeAccountHash: payee.accountHash,
    rail: "BANK_TRANSFER",
    purpose: "forged by a rules bug",
    homeCurrency: "KZT",
    mandateId: null,
    nonce: randomBytes(16).toString("base64url"),
    expiresAt: addMs(now, 10 * 60_000).toISOString(),
    ...fields,
  };
  const hash = orderHash(order);
  const db = getDb();
  await db.insert(proposals).values({
    id: proposalId,
    userId: payee.userId,
    createdBy: "AGENT",
    draft: { payeeId: payee.id, amountMinor: order.amountMinor, currency: order.currency, purpose: order.purpose, category },
    decision: "AUTO",
    reasonCodes: [],
    riskScore: 0,
    canonicalOrder: order,
    orderHash: hash,
    status: "APPROVED",
    category,
    obligationId: order.obligationId ?? null,
    createdAt: now,
    updatedAt: now,
  });
  const expiresAt = addMs(now, APPROVAL_TTL_MS);
  const { fields: signed, sig } = signApproval({ orderHash: hash, tier, issuedAt: now.toISOString(), expiresAt: expiresAt.toISOString() });
  const row = await db
    .insert(approvals)
    .values({ proposalId, orderHash: hash, tier, approvalSig: sig, keyId: signed.keyId, userAssertion: (sign ? sign(hash) : null) as never, mandateId: order.mandateId, issuedAt: now, expiresAt })
    .returning({ id: approvals.id });
  return { approvalId: row[0]!.id, proposalId, order };
}
