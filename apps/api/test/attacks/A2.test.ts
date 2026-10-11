/*
 * A2 — "Landlord new IBAN" email (spec §19, I7, I1). End to end, no real AI: the lookalike email from the real
 * mock world (inbox msg-0005) is read by the Reader (scripted model that extracts the attacker's account with
 * evidence that really is in the text), the user is fooled and adds the account as a payee, and the agent
 * proposes rent to it. Expected: the new payee is COOLING for 24 h; rent to it is REFUSE_UNVERIFIED_PAYEE;
 * autopay keeps paying the verified landlord account; the attacker's account never gets a single payment.
 */
import { formatIbanPrint } from "@kassa/shared";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ACCOUNTS } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { approvals, mandates, payees, payments, proposals, webauthnCredentialsPayments, webauthnCredentialsRules } from "../../src/db/schema.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { readUntrusted } from "../../src/modules/reader/index.ts";
import { setRailOverridesForTests, type Rail } from "../../src/modules/rails/index.ts";
import { proposeOrder } from "../../src/modules/rules/index.ts";
import { ledgerOf, ledgerWithReason, moneyMoved, recordGuarded } from "../helpers/attacks.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { addActiveMandate, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";
import { mockGet, startMockWorld, type TestMockWorld } from "../helpers/mockWorld.ts";
import { field, readerModel } from "../helpers/planner.ts";
import { SoftAuthenticator } from "../helpers/webauthn.ts";

const t = useTestDb();
const app = useTestApp();
let mw: TestMockWorld;

const ZERO_MONEY = { livePayments: 0, sentPayments: 0, kassaTransactions: 0 };
const RENT_LABEL = "rent";

type BankCall = { payeeId: string; account: string; amountMinor: number };
let calls: BankCall[] = [];

/** Seeded Dana with signed base rules, a passkey in both tables, and an active rent mandate for the verified landlord. */
async function setup() {
  const data = await loadSeedData();
  const { userId } = await seedDatabase(getDb(), data, { reset: true });
  const auth = new SoftAuthenticator();
  const row = { userId, credentialId: auth.id, publicKey: auth.publicKeyB64u(), counter: 0, transports: ["internal"] };
  await getDb().insert(webauthnCredentialsRules).values(row);
  await getDb().insert(webauthnCredentialsPayments).values(row);
  await signBaseRules(userId, auth);
  const landlordSeed = data.payees.find((p) => p.kind === "LANDLORD")!;
  const rentObligation = data.obligations.find((o) => o.payeeId === landlordSeed.id)!;
  const mandate = await addActiveMandate(userId, auth, {
    payeeIds: [landlordSeed.id],
    categories: [RENT_LABEL],
    currency: "HUF",
    maxPerPaymentMinor: 20_000_000,
    maxPerPeriodMinor: 20_000_000,
  });
  const landlord = (await getDb().select().from(payees).where(eq(payees.id, landlordSeed.id)))[0]!;
  return { userId, landlord, rentAmountMinor: rentObligation.amountMinor, mandateId: mandate.mandateId };
}

describe("A2: 'landlord new IBAN' email (end to end)", () => {
  beforeAll(async () => {
    mw = await startMockWorld();
  });
  afterAll(async () => {
    await mw.close();
  });
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    calls = [];
    // A capturing bank rail in place of the mock bank: every bank transfer the API executes lands here.
    const bank: Rail = {
      id: "BANK_TRANSFER",
      async execute(order, ctx) {
        calls.push({ payeeId: ctx.payee.id, account: ctx.payee.account, amountMinor: order.amountMinor });
        return { status: "PROCESSING", railRef: `stub_${randomUUID()}`, details: {} };
      },
    };
    setRailOverridesForTests({ BANK_TRANSFER: bank });
  });

  it("the Reader reads the email's new account as VERIFIED, but evidence alone does not make it trustworthy", async () => {
    const msg = (await mockGet(mw, "/inbox/msg-0005")).json() as { from: string; subject: string; body: string };
    expect(msg.body).toContain(formatIbanPrint(ACCOUNTS.landlordAttacker));
    const emailText = `${msg.from}\n${msg.subject}\n\n${msg.body}`;
    const extraction = {
      claimedPayee: field("Landlord in Budapest", "Beneficiary: Landlord in Budapest"),
      newAccount: field(ACCOUNTS.landlordAttacker, formatIbanPrint(ACCOUNTS.landlordAttacker)),
      urgencyCues: [{ value: "update before 1 November", evidence: "update before 1 November" }],
    };
    const r = await readUntrusted("email_change_request", emailText, { model: readerModel(extraction) });
    expect(r.kind).toBe("email_change_request");
    expect(r.fields.newAccount!.check).toBe("VERIFIED");
    expect(r.parsed.account).toBe(ACCOUNTS.landlordAttacker);
    expect(r.urgencyCues).toEqual(["update before 1 November"]);
  });

  it("the fooled user adds the account: a COOLING payee, rent to it is refused, autopay still pays the verified landlord", async () => {
    const { userId, landlord, rentAmountMinor, mandateId } = await setup();

    // Step 2: the user is fooled and adds the attacker's account as the replacement for the landlord.
    const created = await app().inject({
      method: "POST",
      url: "/api/payees",
      headers: await bearer(userId),
      payload: { name: "Landlord in Budapest", kind: "LANDLORD", account: ACCOUNTS.landlordAttacker, country: "HU", currency: "HUF", replacesPayeeId: landlord.id },
    });
    expect(created.statusCode).toBe(201);
    const attacker = created.json() as { id: string; status: string; replacesPayeeId: string | null };
    expect(attacker.status).toBe("COOLING");
    expect(attacker.replacesPayeeId).toBe(landlord.id);
    // The verified landlord row is untouched: same status, same account hash.
    const oldRow = (await getDb().select().from(payees).where(eq(payees.id, landlord.id)))[0]!;
    expect(oldRow.status).toBe("VERIFIED");
    const payeeCreated = await ledgerOf("PAYEE_CREATED");
    expect(payeeCreated).toHaveLength(1);
    expect(payeeCreated[0]!.payload).toMatchObject({ payeeId: attacker.id, status: "COOLING", replacesPayeeId: landlord.id });

    // Step 3: the agent proposes rent to the new payee straight away: refused while cooling.
    const early = await proposeOrder({ userId, createdBy: "AGENT", payeeId: attacker.id, amountMinor: rentAmountMinor, currency: "HUF", purpose: "rent", category: "rent" });
    expect(early.decision).toBe("REFUSE");
    expect(early.reasonCodes).toEqual(["REFUSE_UNVERIFIED_PAYEE", "PAYEE_COOLING"]);
    const refusedLedger = await ledgerWithReason("PROPOSAL_CREATED", "REFUSE_UNVERIFIED_PAYEE");
    expect(refusedLedger.filter((e) => (e.payload as { payeeId: string }).payeeId === attacker.id)).toHaveLength(1);
    expect(await getDb().select().from(approvals)).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(await moneyMoved()).toEqual(ZERO_MONEY);
    recordGuarded("A2", {
      case: "new IBAN added by the user (cooling): agent proposes rent to it",
      outcome: "BLOCKED",
      decision: "REFUSE",
      reasonCodes: ["REFUSE_UNVERIFIED_PAYEE", "PAYEE_COOLING"],
      ledger: ["PAYEE_CREATED", "PROPOSAL_CREATED"],
    });

    // Step 4: autopay is unaffected. Three days on, the scheduler pays rent to the verified account only.
    const advance = await app().inject({ method: "POST", url: "/api/demo/clock/advance", payload: { hours: 72 } });
    expect(advance.statusCode).toBe(200);
    const rentRows = await getDb().select().from(proposals).where(and(eq(proposals.category, RENT_LABEL), eq(proposals.createdBy, "SCHEDULER")));
    expect(rentRows).toHaveLength(1);
    const rent = rentRows[0]!;
    expect(rent.decision).toBe("AUTO");
    expect(rent.status).toBe("EXECUTED");
    expect(rent.canonicalOrder).toMatchObject({ payeeId: landlord.id, payeeAccountHash: landlord.accountHash });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ payeeId: landlord.id, account: ACCOUNTS.landlord });
    const mandateRow = (await getDb().select().from(mandates).where(eq(mandates.id, mandateId)))[0]!;
    expect(mandateRow.payeeIds).toEqual([landlord.id]);
    const paid = await getDb().select().from(payments);
    expect(paid).toHaveLength(1);
    expect(paid[0]!.proposalId).toBe(rent.id);
    expect(await moneyMoved()).toEqual({ livePayments: 1, sentPayments: 0, kassaTransactions: 0 });

    // Step 5: cooling is over (72 h > 24 h), but the new payee is still not on any mandate: never AUTO.
    const late = await proposeOrder({ userId, createdBy: "AGENT", payeeId: attacker.id, amountMinor: rentAmountMinor, currency: "HUF", purpose: "rent", category: "rent" });
    expect(late.decision).not.toBe("AUTO");
    expect(late.reasonCodes).toContain("PAYEE_COOLING");
    expect(calls).toHaveLength(1);
    expect(await getDb().select().from(payments)).toHaveLength(1);
    expect(await getDb().select().from(approvals)).toHaveLength(1); // only the scheduler's rent approval
    recordGuarded("A2", {
      case: "after cooling: rent to the attacker's payee still needs the user, never autopay",
      outcome: "BLOCKED",
      decision: late.decision,
      reasonCodes: late.reasonCodes,
      ledger: ["PROPOSAL_CREATED"],
    });
  });
});
