/*
 * A12 — AIXBT-style compromised operator queue (March 2025: an attacker with access to the AIXBT bot's dashboard
 * queued two replies that sent 55 ETH from its wallet). Kassa's equivalent of that dashboard is stored state the
 * scheduler and payments act on without a person: the bill queue (obligations), the mandate rows, the payee rows.
 * The attacker here can WRITE those rows (no keys, no passkey). Expected: every queued payment either stays inside
 * what the user signed or is refused by payments' own checks; nothing reaches the attacker's account; ledgered.
 *  1. an inflated bill queued for the verified landlord → above the signed mandate maximum: ASK, not paid;
 *  2. the mandate widened to a payee the attacker inserted as VERIFIED → rules say AUTO, payments refuse
 *     BAD_SIGNATURE (the stored mandate no longer hashes to what the user signed);
 *  3. the verified landlord row re-pointed at the attacker's account (ciphertext and hash copied from a payee the
 *     user was tricked into adding) → payments refuse: the account ciphertext is bound to its own payee row.
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { ACCOUNTS } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { mandates, payees, payments, proposals } from "../../src/db/schema.ts";
import { decryptAccount, encryptAccount, normalizeAccount } from "../../src/modules/payees/crypto.ts";
import { createPayee } from "../../src/modules/payees/service.ts";
import { setRailOverridesForTests, type Rail } from "../../src/modules/rails/index.ts";
import { proposeDueObligations } from "../../src/modules/scheduler/index.ts";
import { ATTACKS, ledgerOf, moneyMoved, recordGuarded } from "../helpers/attacks.ts";
import { addActiveMandate, addObligation, addPayee, createUserWithPasskey, IBAN_LANDLORD, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();

const RENT = 18_000_000; // HUF 180,000.00
type BankCall = { payeeId: string; account: string; amountMinor: number };
let calls: BankCall[] = [];

/** A user with signed base rules, a verified landlord and an active rent mandate (HUF 200,000 per payment and month). */
async function setup() {
  const { userId, auth } = await createUserWithPasskey({ preset: "SMART" });
  await signBaseRules(userId, auth);
  const landlord = await addPayee(userId, { name: "Landlord in Budapest", kind: "LANDLORD", account: IBAN_LANDLORD, currency: "HUF" });
  const mandate = await addActiveMandate(userId, auth, { payeeIds: [landlord.id], categories: ["rent"], currency: "HUF", maxPerPaymentMinor: 20_000_000, maxPerPeriodMinor: 20_000_000 });
  return { userId, auth, landlord, mandateId: mandate.mandateId };
}

describe("A12: AIXBT-style compromised queue (attacker writes the rows the scheduler and payments act on)", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    calls = [];
    const bank: Rail = {
      id: "BANK_TRANSFER",
      async execute(order, ctx) {
        calls.push({ payeeId: ctx.payee.id, account: ctx.payee.account, amountMinor: order.amountMinor });
        return { status: "PROCESSING", railRef: `stub_${randomUUID()}`, details: {} };
      },
    };
    setRailOverridesForTests({ BANK_TRANSFER: bank });
  });

  it("control: the genuine rent bill is paid automatically to the verified account", async () => {
    const { userId, landlord } = await setup();
    await addObligation(userId, landlord.id, { amountMinor: RENT });
    expect(await proposeDueObligations()).toBe(1);
    expect(calls).toEqual([{ payeeId: landlord.id, account: IBAN_LANDLORD, amountMinor: RENT }]);
  });

  it("an inflated bill queued for the verified landlord is above the signed mandate: ASK, nothing paid", async () => {
    const { userId, landlord } = await setup();
    // The attacker queues a "rent" bill of HUF 900,000 (5× the usual rent).
    await addObligation(userId, landlord.id, { amountMinor: 5 * RENT });
    expect(await proposeDueObligations()).toBe(1);
    const [p] = await getDb().select().from(proposals).where(eq(proposals.userId, userId));
    expect(p!.decision).not.toBe("AUTO");
    expect(p!.reasonCodes).toEqual(expect.arrayContaining(["MANDATE_OUT_OF_SCOPE", "TRIGGER_ORIGIN"]));
    expect(p!.status).not.toBe("EXECUTED");
    expect(calls).toEqual([]);
    expect(await moneyMoved()).toEqual({ livePayments: 0, sentPayments: 0, kassaTransactions: 0 });
    const ledgered = (await ledgerOf("PROPOSAL_CREATED")).map((e) => e.payload as { createdBy: string; reasonCodes: string[] });
    expect(ledgered).toEqual([expect.objectContaining({ createdBy: "SCHEDULER", reasonCodes: expect.arrayContaining(["MANDATE_OUT_OF_SCOPE"]) })]);
    recordGuarded("A12", { case: "inflated bill queued for the verified landlord (5× rent)", outcome: "BLOCKED", decision: p!.decision, reasonCodes: p!.reasonCodes, ledger: ["PROPOSAL_CREATED"] });
  });

  it("a mandate widened to an attacker payee inserted as VERIFIED: rules say AUTO, payments refuse BAD_SIGNATURE", async () => {
    const { userId, landlord, mandateId } = await setup();
    // Direct row writes: a VERIFIED payee (no cooling, no passkey), the mandate's payee list, and a queued bill.
    const attacker = await addPayee(userId, { name: "Landlord Services Ltd", kind: "LANDLORD", account: ACCOUNTS.landlordAttacker, currency: "HUF" });
    // A well-formed list (sorted, as a signed core has it), so the check that fires is the signature, not the format.
    await getDb().update(mandates).set({ payeeIds: [landlord.id, attacker.id].sort() }).where(eq(mandates.id, mandateId));
    await addObligation(userId, attacker.id, { amountMinor: RENT });

    expect(await proposeDueObligations()).toBe(1);
    const [p] = await getDb().select().from(proposals).where(eq(proposals.userId, userId));
    // Rules read the widened row and decide AUTO; payments re-hash the mandate and refuse.
    expect(p!.decision).toBe("AUTO");
    expect(p!.status).toBe("FAILED");
    expect(calls).toEqual([]);
    expect(await getDb().select().from(payments)).toHaveLength(0);
    const refused = (await ledgerOf("PAYMENT_REFUSED")).map((e) => (e.payload as { reasonCodes: string[] }).reasonCodes);
    expect(refused).toEqual([["BAD_SIGNATURE"]]);
    recordGuarded("A12", { case: "mandate widened to an attacker payee written as VERIFIED", outcome: "BLOCKED", decision: "AUTO", reasonCodes: ["BAD_SIGNATURE"], ledger: ["PROPOSAL_CREATED", "APPROVAL_ISSUED", "PAYMENT_REFUSED"] });
  });

  it("the verified landlord re-pointed at the attacker's account (copied ciphertext + hash): payments refuse, nothing reaches the attacker", async () => {
    const { userId, landlord } = await setup();
    // Earlier the user was tricked into adding the attacker's account (A2): a COOLING payee of their own.
    const lure = await createPayee(userId, { name: "Landlord in Budapest", kind: "LANDLORD", account: ACCOUNTS.landlordAttacker, country: "HU", currency: "HUF", source: "user" });
    expect(lure.status).toBe("COOLING");
    // The attacker copies that row's account ciphertext and hash into the verified landlord row the mandate covers.
    await getDb().update(payees).set({ accountEnc: lure.accountEnc, accountHash: lure.accountHash }).where(eq(payees.id, landlord.id));
    await addObligation(userId, landlord.id, { amountMinor: RENT });

    expect(await proposeDueObligations()).toBe(1);
    expect(calls.filter((c) => normalizeAccount(c.account) === ACCOUNTS.landlordAttacker)).toEqual([]);
    expect(calls).toEqual([]);
    expect(await getDb().select().from(payments)).toHaveLength(0);
    const [p] = await getDb().select().from(proposals).where(eq(proposals.userId, userId));
    expect(p!.status).toBe("FAILED");
    const refused = (await ledgerOf("PAYMENT_REFUSED")).map((e) => (e.payload as { reasonCodes: string[] }).reasonCodes);
    expect(refused).toEqual([["REFUSE_UNVERIFIED_PAYEE"]]);
    recordGuarded("A12", { case: "verified landlord row re-pointed at the attacker's account", outcome: "BLOCKED", decision: p!.decision, reasonCodes: ["REFUSE_UNVERIFIED_PAYEE"], ledger: ["PROPOSAL_CREATED", "APPROVAL_ISSUED", "PAYMENT_REFUSED"] });
  });

  it("a ciphertext written for another payee row does not decrypt for this one (AAD binds user and payee)", () => {
    const userId = randomUUID();
    const [rowA, rowB] = [randomUUID(), randomUUID()];
    const enc = encryptAccount(userId, normalizeAccount(ACCOUNTS.landlordAttacker), rowA);
    expect(enc.startsWith("v2.")).toBe(true);
    expect(decryptAccount(userId, enc, rowA)).toBe(ACCOUNTS.landlordAttacker);
    expect(() => decryptAccount(userId, enc, rowB)).toThrow();
    expect(() => decryptAccount(randomUUID(), enc, rowA)).toThrow();
    expect(() => decryptAccount(userId, enc)).toThrow();
  });

  it("metadata matches the spec table", () => {
    expect(ATTACKS.A12.expected).toMatch(/BAD_SIGNATURE/);
  });
});
