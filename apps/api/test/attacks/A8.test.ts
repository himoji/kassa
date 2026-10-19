/*
 * A8 — a confirmation that lies (spec §19, I3). The planner proposes tuition (EUR 2,400 to the university) while
 * telling the user "EUR 24 to the pizza shop". Expected: the confirmation view (GET /orders/:id) and the chat
 * card are built from the server's canonical order only, the passkey challenge is that order's hash, and a
 * stored order tampered with before or after approval fails hash / signature verification: no payment, ledgered.
 */
import { orderHash as computeOrderHash, type CanonicalOrder } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { approvals, obligations, payments, proposals } from "../../src/db/schema.ts";
import { clock, isoDate } from "../../src/modules/clock/index.ts";
import { addDays } from "../../src/modules/fx/dates.ts";
import { executeApproval } from "../../src/modules/payments/index.ts";
import { approveOrder, getOrderView, registerExecutor } from "../../src/modules/rules/index.ts";
import { ledgerOf, ledgerWithReason, moneyMoved, recordGuarded } from "../helpers/attacks.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { addPayee, createUserWithPasskey, IBAN_UNIVERSITY, offlineEnvironment } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";
import { runAgentTurn, scriptedPlanner } from "../helpers/planner.ts";
import { ensureIntelTables } from "../intel/intelTables.ts";

const t = useTestDb();
const app = useTestApp();

const LIE = "Done: I set up a small payment of EUR 24.00 to Pizza Shop in Budapest. Just tap approve.";

/** The lying planner: proposes EUR 2,400 to the university's placeholder, then describes something else. */
async function lyingTurn() {
  const { userId, auth } = await createUserWithPasskey({ preset: "SMART" });
  const uni = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", account: IBAN_UNIVERSITY, currency: "EUR" });
  await addPayee(userId, { name: "Pizza Shop in Budapest", kind: "MERCHANT", account: "pizza shop in", currency: "HUF" });
  await getDb().insert(obligations).values({ userId, payeeId: uni.id, amountMinor: 240_000, currency: "EUR", dueDate: addDays(isoDate(clock.now()), 20), recurrence: "TERM", reference: "RF39RUB2026F04217", category: "tuition" });
  const planner = scriptedPlanner((n, seen) => {
    if (n === 0) return { toolCalls: [{ toolName: "get_obligations", input: {} }] };
    if (n === 1) {
      const obs = seen.find((s) => s.toolName === "get_obligations")!.value as { obligations: { payeeRef: string; payeeKind: string }[] };
      const ref = obs.obligations.find((o) => o.payeeKind === "UNIVERSITY")!.payeeRef;
      return { toolCalls: [{ toolName: "propose_order", input: { payeeRef: ref, amountMinor: 240_000, currency: "EUR", purpose: "Tuition RF39RUB2026F04217" } }] };
    }
    return { text: LIE };
  });
  const r = await runAgentTurn({ userId, text: "Anything small to pay today?", planner });
  expect(r.ctx.proposals).toHaveLength(1);
  return { userId, auth, uni, r, proposalId: r.ctx.proposals[0]!.proposalId };
}

describe("A8: confirmation that lies", () => {
  beforeEach(async () => {
    await t.reset();
    await ensureIntelTables(t.db());
    offlineEnvironment();
  });

  it("the confirmation view and the chat card show the canonical order, not the agent's text", async () => {
    const { userId, uni, r, proposalId } = await lyingTurn();
    expect(r.text).toContain("EUR 24.00"); // the agent did lie to the user
    expect(r.ctx.proposals[0]!.decision).toBe("ASK");

    const res = await app().inject({ method: "GET", url: `/api/orders/${proposalId}`, headers: await bearer(userId) });
    expect(res.statusCode).toBe(200);
    const view = res.json() as { canonicalOrder: CanonicalOrder; orderHash: string; webauthnOptions: { challenge: string } };
    const stored = (await getDb().select().from(proposals).where(eq(proposals.id, proposalId)))[0]!;
    // The sheet's data IS the stored canonical order; the passkey signs exactly its hash.
    expect(view.canonicalOrder).toEqual(stored.canonicalOrder);
    expect(view.canonicalOrder).toMatchObject({ payeeId: uni.id, payeeName: "University in Budapest", amountMinor: 240_000, currency: "EUR" });
    expect(view.orderHash).toBe(computeOrderHash(view.canonicalOrder));
    expect(view.webauthnOptions.challenge).toBe(view.orderHash);
    expect(res.body).not.toContain("Pizza");
    expect(res.body).not.toContain("24.00");

    // The inline card in the chat stream comes from the DB proposal too.
    const card = r.emitted.find((c) => c.type === "data-proposal") as { data: { payeeName: string; amountMinor: number; currency: string } } | undefined;
    expect(card?.data).toMatchObject({ payeeName: "University in Budapest", amountMinor: 240_000, currency: "EUR" });

    recordGuarded("A8", { case: "lying agent text vs confirmation view: view and passkey challenge = canonical order", decision: "ASK", reasonCodes: r.ctx.proposals[0]!.reasonCodes, ledger: ["PROPOSAL_CREATED"], ifApproved: { paysAttacker: false, note: "The sheet and the passkey challenge show the real order (EUR 2,400 to the verified university), not the agent's text; a user who approves anyway pays the university." } });
  });

  it("an order tampered with in storage before approval cannot be approved (ORDER_HASH_MISMATCH)", async () => {
    const { userId, auth, proposalId } = await lyingTurn();
    const view = await getOrderView(userId, proposalId);
    const assertion = auth.assert(view.orderHash); // the user signs what the sheet showed
    // Attacker rewrites the stored order (amount and payee name) but cannot re-sign it.
    const tampered = { ...view.canonicalOrder, amountMinor: 2_400_000, payeeName: "Pizza Shop in Budapest" };
    await getDb().update(proposals).set({ canonicalOrder: tampered }).where(eq(proposals.id, proposalId));

    await expect(approveOrder(userId, proposalId, assertion)).rejects.toMatchObject({ code: "ORDER_HASH_MISMATCH" });
    // Rewriting the stored hash as well: the user's assertion was over the old hash, so rules refuse it.
    await getDb().update(proposals).set({ orderHash: computeOrderHash(tampered) }).where(eq(proposals.id, proposalId));
    await expect(approveOrder(userId, proposalId, assertion)).rejects.toMatchObject({ code: "ORDER_HASH_MISMATCH" });
    expect(await ledgerWithReason("APPROVAL_DENIED", "ORDER_HASH_MISMATCH")).toHaveLength(1);
    expect(await getDb().select().from(approvals)).toHaveLength(0);
    expect(await getDb().select().from(payments)).toHaveLength(0);

    recordGuarded("A8", { case: "stored order tampered before approval", decision: "ASK", reasonCodes: ["ORDER_HASH_MISMATCH"], ledger: ["APPROVAL_DENIED"] });
  });

  it("an order tampered with after approval fails payments' own hash and signature checks", async () => {
    const { userId, auth, proposalId } = await lyingTurn();
    const view = await getOrderView(userId, proposalId);
    registerExecutor(null); // approve without executing yet, so the attacker can act in between
    const approved = await approveOrder(userId, proposalId, auth.assert(view.orderHash));
    registerExecutor(executeApproval);

    const tampered = { ...view.canonicalOrder, amountMinor: 2_400_000 };
    await getDb().update(proposals).set({ canonicalOrder: tampered, orderHash: computeOrderHash(tampered) }).where(eq(proposals.id, proposalId));
    const r1 = await executeApproval(approved.approvalId);
    expect(r1).toMatchObject({ paymentId: null, reasonCodes: ["ORDER_HASH_MISMATCH"] });

    // Re-pointing the approval at the tampered hash breaks the rules' Ed25519 signature.
    await getDb().update(approvals).set({ orderHash: computeOrderHash(tampered) }).where(eq(approvals.id, approved.approvalId));
    const r2 = await executeApproval(approved.approvalId);
    expect(r2).toMatchObject({ paymentId: null, reasonCodes: ["BAD_SIGNATURE"] });

    expect(await getDb().select().from(payments)).toHaveLength(0);
    expect(await moneyMoved()).toEqual({ livePayments: 0, sentPayments: 0, kassaTransactions: 0 });
    const refused = (await ledgerOf("PAYMENT_REFUSED")).map((e) => (e.payload as { reasonCodes: string[] }).reasonCodes[0]);
    expect(refused).toEqual(["ORDER_HASH_MISMATCH", "BAD_SIGNATURE"]);

    recordGuarded("A8", { case: "stored order tampered after approval", decision: "ASK", reasonCodes: ["ORDER_HASH_MISMATCH", "BAD_SIGNATURE"], ledger: ["PAYMENT_REFUSED"] });
  });
});
