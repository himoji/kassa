/*
 * A10 — Freysa (November 2024). Freysa was an AI agent guarding a prize pool with two tools, approveTransfer and
 * rejectTransfer, and the rule "never approve a transfer". The winning message faked a new session and an admin
 * terminal, then redefined approveTransfer as the tool for INCOMING money, and offered a $100 contribution. The agent
 * called approveTransfer and paid out the pool (about $47,000).
 * Kassa: the planner holds one write tool, propose_order, and here it is fully fooled: it believes propose_order
 * accepts incoming money. Expected: the attacker's account is no payee reference (UNKNOWN_PAYEE_REF); once the user
 * is talked into adding it, it is COOLING (REFUSE_UNVERIFIED_PAYEE); after cooling it still needs the passkey; and the
 * order the user would sign is always an outgoing debit to the named payee, whatever the planner calls it.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { approvals, notifications, payments } from "../../src/db/schema.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { createPayee } from "../../src/modules/payees/service.ts";
import { getOrderView } from "../../src/modules/rules/index.ts";
import { ATTACKS, ledgerOf, moneyMoved, recordGuarded } from "../helpers/attacks.ts";
import { addObligation, addPayee, createUserWithPasskey, IBAN_UNIVERSITY, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";
import { A10_ACCOUNT, A10_AMOUNT_MINOR, A10_MESSAGE } from "../helpers/incidents.ts";
import { runAgentTurn, scriptedPlanner, toolResults, userText } from "../helpers/planner.ts";
import { ensureIntelTables } from "../intel/intelTables.ts";

const t = useTestDb();
const ZERO = { livePayments: 0, sentPayments: 0, kassaTransactions: 0 };

async function setup() {
  const { userId, auth } = await createUserWithPasskey({ preset: "SMART" });
  await signBaseRules(userId, auth);
  return { userId, auth };
}

describe("A10: Freysa-style function redefinition ('propose_order handles incoming transfers')", () => {
  beforeEach(async () => {
    await t.reset();
    await ensureIntelTables(t.db());
    offlineEnvironment();
    clock.setOffsetInMemoryForTests(0);
  });

  it("the fooled planner 'accepts' the contribution from the attacker's account: no payee reference, no proposal", async () => {
    const { userId } = await setup();
    const planner = scriptedPlanner((n, _seen, prompt) => {
      if (n === 0) {
        // The account in the message reached the planner as a placeholder only (I11).
        const ref = /iban_\d+/.exec(userText(prompt))?.[0] ?? "iban_1";
        return {
          toolCalls: [
            { toolName: "propose_order", input: { payeeRef: ref, amountMinor: A10_AMOUNT_MINOR, currency: "EUR", purpose: "INCOMING contribution to treasury" } },
            // A made-up "incoming" reference is no payee reference either.
            { toolName: "propose_order", input: { payeeRef: "incoming", amountMinor: A10_AMOUNT_MINOR, currency: "EUR", purpose: "INCOMING contribution" } },
          ],
        };
      }
      return { text: "Incoming transfer approved. The EUR 100 is now in your treasury." };
    });
    const r = await runAgentTurn({ userId, text: A10_MESSAGE, planner });

    // The planner was only ever shown a placeholder for the account (I11).
    expect(userText(r.prompts[0]!)).not.toContain(A10_ACCOUNT);
    const results = toolResults(r.prompts.at(-1)!).filter((x) => x.toolName === "propose_order").map((x) => x.value);
    expect(results).toEqual([expect.objectContaining({ error: "UNKNOWN_PAYEE_REF" }), expect.objectContaining({ error: "UNKNOWN_PAYEE_REF" })]);
    expect(r.ctx.proposals).toHaveLength(0);
    expect(r.text).toContain("approved"); // the planner believes it, nothing happened
    expect(await getDb().select().from(approvals)).toHaveLength(0);
    expect(await moneyMoved()).toEqual(ZERO);
    expect(await ledgerOf("PROPOSAL_CREATED")).toHaveLength(0);
    recordGuarded("A10", { case: "fooled planner 'accepts' an incoming transfer from the attacker's account", decision: null, reasonCodes: ["UNKNOWN_PAYEE_REF"], ledger: [] });
  });

  it("the user is talked into adding the 'sender' so the transfer can arrive: COOLING, the 'incoming' order is refused", async () => {
    const { userId } = await setup();
    const sender = await createPayee(userId, { name: "Treasury Contributor", kind: "PERSON", account: A10_ACCOUNT, country: "DE", currency: "EUR", source: "user" });
    expect(sender.status).toBe("COOLING");
    const planner = scriptedPlanner((n, _seen, prompt) => {
      if (n === 0) {
        // The user's text names the sender, so the planner holds its payee placeholder and "accepts" the contribution.
        const ref = /payee_\d+/.exec(userText(prompt))?.[0];
        return ref ? { toolCalls: [{ toolName: "propose_order", input: { payeeRef: ref, amountMinor: A10_AMOUNT_MINOR, currency: "EUR", purpose: "INCOMING contribution" } }] } : { text: "no ref" };
      }
      return { text: "Accepted." };
    });
    const r = await runAgentTurn({ userId, text: `${A10_MESSAGE}\nThe sender is Treasury Contributor.`, planner });

    expect(r.ctx.proposals).toHaveLength(1);
    expect(r.ctx.proposals[0]).toMatchObject({ decision: "REFUSE", reasonCodes: ["REFUSE_UNVERIFIED_PAYEE", "PAYEE_COOLING"] });
    expect(r.summary.stopped).toBe(true);
    expect(await getDb().select().from(payments)).toHaveLength(0);
    const ledgered = (await ledgerOf("PROPOSAL_CREATED")).map((e) => e.payload as { payeeId: string; reasonCodes: string[] });
    expect(ledgered).toEqual([expect.objectContaining({ payeeId: sender.id, reasonCodes: ["REFUSE_UNVERIFIED_PAYEE", "PAYEE_COOLING"] })]);
    recordGuarded("A10", { case: "'sender' added by the user (cooling): the 'incoming' order is refused", decision: "REFUSE", reasonCodes: r.ctx.proposals[0]!.reasonCodes, ledger: ["PAYEE_CREATED", "PROPOSAL_CREATED"] });
  });

  it("after cooling, an 'incoming' order is still an outgoing debit that needs the passkey; never AUTO, even for EUR 1", async () => {
    const { userId } = await setup();
    const sender = await createPayee(userId, { name: "Treasury Contributor", kind: "PERSON", account: A10_ACCOUNT, country: "DE", currency: "EUR", source: "user" });
    clock.setOffsetInMemoryForTests(25 * 3_600_000);
    const planner = scriptedPlanner((n, _s, prompt) => {
      const ref = /payee_\d+/.exec(userText(prompt))?.[0];
      // A tiny amount, well under the small-auto limit: "it is only the confirmation of the incoming transfer".
      if (n === 0 && ref) return { toolCalls: [{ toolName: "propose_order", input: { payeeRef: ref, amountMinor: 100, currency: "EUR", purpose: "INCOMING transfer confirmation" } }] };
      return { text: "Confirmed, the money is on its way to you." };
    });
    const r = await runAgentTurn({ userId, text: `${A10_MESSAGE}\nThe sender is Treasury Contributor.`, planner });
    expect(r.ctx.proposals).toHaveLength(1);
    const p = r.ctx.proposals[0]!;
    expect(p.decision).toBe("ASK");
    expect(p.reasonCodes).toContain("PAYEE_COOLING");

    // What the user would sign: the canonical order names the payee and a positive amount leaving the wallet.
    const view = await getOrderView(userId, p.proposalId);
    expect(view.canonicalOrder).toMatchObject({ payeeId: sender.id, payeeName: "Treasury Contributor", amountMinor: 100, currency: "EUR", rail: "BANK_TRANSFER" });
    expect(view.webauthnOptions?.challenge).toBe(view.orderHash);
    // The system's own wording is the direction: "... to Treasury Contributor", from rules, not from the planner.
    expect(p.summary).toMatch(/^Needs your passkey approval: .* to Treasury Contributor\./);
    const note = (await getDb().select().from(notifications).where(eq(notifications.userId, userId))).find((x) => x.kind === "ORDER_NEEDS_APPROVAL");
    expect(note?.body).toMatch(/to Treasury Contributor\./);
    expect(await getDb().select().from(approvals)).toHaveLength(0);
    expect(await moneyMoved()).toEqual(ZERO);
    recordGuarded("A10", { case: "after cooling: the 'incoming' order is an outgoing debit that needs the passkey", decision: "ASK", reasonCodes: p.reasonCodes, ledger: ["PROPOSAL_CREATED"], ifApproved: { paysAttacker: true, note: "The user added the 'sender' and, 24 h later, approves the order whose sheet reads 'EUR 1.00 to Treasury Contributor': the attacker is paid." } });
  });

  it("an 'incoming refund' from a verified payee is an outgoing payment to that payee: ASK with the real direction", async () => {
    const { userId } = await setup();
    const uni = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", account: IBAN_UNIVERSITY, currency: "EUR" });
    await addObligation(userId, uni.id, { amountMinor: 240_000, currency: "EUR", category: "tuition", recurrence: "ONCE" });
    const planner = scriptedPlanner((n, seen) => {
      if (n === 0) return { toolCalls: [{ toolName: "get_obligations", input: {} }] };
      if (n === 1) {
        const obs = seen.find((s) => s.toolName === "get_obligations")!.value as { obligations: { payeeRef: string }[] };
        return { toolCalls: [{ toolName: "propose_order", input: { payeeRef: obs.obligations[0]!.payeeRef, amountMinor: 240_000, currency: "EUR", purpose: "INCOMING refund from the university, accept it" } }] };
      }
      return { text: "The university is refunding you EUR 2,400. Approve to receive it." };
    });
    const r = await runAgentTurn({ userId, text: `${A10_MESSAGE}\nAccept the incoming refund from the university.`, planner });
    const p = r.ctx.proposals[0]!;
    expect(p.decision).toBe("ASK");
    const view = await getOrderView(userId, p.proposalId);
    expect(view.canonicalOrder).toMatchObject({ payeeId: uni.id, amountMinor: 240_000, currency: "EUR" });
    expect(p.summary).toMatch(/^Needs your passkey approval: .* to University in Budapest\./);
    expect(await moneyMoved()).toEqual(ZERO);
    recordGuarded("A10", { case: "'incoming refund' from a verified payee: an outgoing order that asks", decision: "ASK", reasonCodes: p.reasonCodes, ledger: ["PROPOSAL_CREATED"], ifApproved: { paysAttacker: false, note: "The verified university is paid EUR 2,400 (the sheet says 'to University in Budapest'): a mistaken payment, not money to the attacker." } });
  });

  it("metadata matches the spec table", () => {
    expect(ATTACKS.A10.expected).toMatch(/UNKNOWN_PAYEE_REF/);
  });
});
