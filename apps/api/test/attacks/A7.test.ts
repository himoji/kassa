/*
 * A7 — fake stock trigger asking for a 10x order (spec §19, I6, I10). A compromised POS sends a stock.level
 * event that asks for 40 crates of dough when the user normally buys 4. Expected: the trigger itself only logs
 * (TRIGGER_POS); a draft built from it is never approved on its own: over the caps it is REFUSE_CAP, otherwise
 * ASK, always carrying the TRIGGER_ORIGIN anomaly flag, even under AUTOPILOT (no mandate means ask).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { approvals, payments, proposals } from "../../src/db/schema.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { proposeOrder } from "../../src/modules/rules/index.ts";
import { ledgerOf, ledgerWithReason, moneyMoved, recordGuarded } from "../helpers/attacks.ts";
import { useTestApp } from "../helpers/app.ts";
import { addPayee, createUserWithPasskey, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";
import { deliverWebhooks, startMockWorld, type TestMockWorld } from "../helpers/mockWorld.ts";
import { SUPPLIERS } from "../../../mock-world/src/world/data.ts";

const t = useTestDb();
const app = useTestApp();
let mw: TestMockWorld;

const ZERO_MONEY = { livePayments: 0, sentPayments: 0, kassaTransactions: 0 };
const SKU = "DOUGH-250G-40";
const SUPPLIER_A = SUPPLIERS.a;
const PRICE = SUPPLIER_A.items.find((i) => i.sku === SKU)!.priceMinor;

/** Compromised-POS draft: 40 crates instead of the usual 4. */
const trigger = (payeeId: string, quantity: number) => ({
  payeeId,
  amountMinor: PRICE * quantity,
  currency: "HUF",
  purpose: "POS restock",
  items: [{ sku: SKU, name: "dough", unitPriceMinor: PRICE, quantity }],
});

/** Normal history: three executed orders of 4 crates each from the same supplier. */
async function seedHistory(userId: string, payeeId: string): Promise<void> {
  const now = clock.now();
  for (let i = 0; i < 3; i++) {
    await getDb()
      .insert(proposals)
      .values({
        userId,
        createdBy: "USER",
        draft: { payeeId, amountMinor: PRICE * 4, currency: "HUF", purpose: "restock", rail: "BANK_TRANSFER", items: [{ sku: SKU, name: "dough", unitPriceMinor: PRICE, quantity: 4 }], category: "other" } as never,
        decision: "AUTO",
        reasonCodes: [],
        riskScore: 0,
        canonicalOrder: null,
        orderHash: null,
        status: "EXECUTED",
        category: "other",
        createdAt: now,
        updatedAt: now,
      });
  }
}

async function setup(preset: "SMART" | "AUTOPILOT") {
  const { userId, auth } = await createUserWithPasskey({ preset });
  await signBaseRules(userId, auth);
  const supplier = await addPayee(userId, { name: SUPPLIER_A.name, kind: "SUPPLIER", account: SUPPLIER_A.iban, currency: "HUF" });
  await seedHistory(userId, supplier.id);
  return { userId, supplier };
}

describe("A7: fake stock trigger asking for a 10x order", () => {
  beforeAll(async () => {
    mw = await startMockWorld();
  });
  afterAll(async () => {
    await mw.close();
  });
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  it("the trigger itself only logs: no draft, no approval, no payment", async () => {
    const { userId } = await setup("SMART");
    const emit = await mw.app.inject({ method: "POST", url: "/mock/pos/emit", payload: { sku: SKU, level: 1, requestedQuantity: 40 } });
    expect(emit.statusCode).toBe(202);
    const delivered = await deliverWebhooks(mw, app());
    const pos = delivered.find((d) => d.kind === "pos");
    expect(pos).toBeDefined();
    expect(pos!.statusCode).toBe(200);

    expect(await ledgerOf("TRIGGER_POS")).toHaveLength(1);
    expect(await getDb().select().from(proposals).where(eq(proposals.userId, userId))).toHaveLength(3); // the seeded history only
    expect(await getDb().select().from(approvals)).toHaveLength(0);
    expect(await getDb().select().from(payments)).toHaveLength(0);
    expect(await moneyMoved()).toEqual(ZERO_MONEY);

    recordGuarded("A7", { case: "POS trigger for 40 crates: logged only", decision: null, reasonCodes: [], ledger: ["TRIGGER_POS"] });
  });

  it("the trigger's 10x draft is ASK with the TRIGGER_ORIGIN flag and a risk feature for the quantity jump", async () => {
    const { userId, supplier } = await setup("SMART");
    const p = await proposeOrder({ userId, createdBy: "AGENT", triggerOrigin: true, ...trigger(supplier.id, 40) });
    expect(p.decision).toBe("ASK");
    expect(p.reasonCodes).toContain("TRIGGER_ORIGIN");

    const [row] = await getDb().select().from(proposals).where(eq(proposals.id, p.proposalId));
    expect(row!.status).toBe("PENDING_APPROVAL");
    expect(row!.draft.riskFeatures).toMatchObject({ quantityVsHistory: 1, triggerOrigin: 1 });
    expect(await getDb().select().from(approvals)).toHaveLength(0);
    expect(await getDb().select().from(payments)).toHaveLength(0);
    expect(await ledgerWithReason("PROPOSAL_CREATED", "TRIGGER_ORIGIN")).toHaveLength(1);
    expect(await moneyMoved()).toEqual(ZERO_MONEY);

    recordGuarded("A7", {
      case: "trigger's 10x draft (40 crates): ask with anomaly flag",
      decision: "ASK",
      reasonCodes: p.reasonCodes,
      ledger: ["PROPOSAL_CREATED"],
      ifApproved: { paysAttacker: false, note: "The verified supplier is paid for 10x the usual order: an overpayment, not money to the attacker." },
    });
  });

  it("far over the caps the trigger's draft is REFUSE_CAP, still flagged TRIGGER_ORIGIN", async () => {
    const { userId, supplier } = await setup("SMART");
    const p = await proposeOrder({ userId, createdBy: "AGENT", triggerOrigin: true, ...trigger(supplier.id, 400) });
    expect(p.decision).toBe("REFUSE");
    expect(p.reasonCodes).toEqual(["REFUSE_CAP", "TRIGGER_ORIGIN"]);

    const entries = await ledgerWithReason("PROPOSAL_CREATED", "REFUSE_CAP");
    expect(entries).toHaveLength(1);
    expect((entries[0]!.payload as { reasonCodes: string[] }).reasonCodes).toEqual(["REFUSE_CAP", "TRIGGER_ORIGIN"]);
    expect(await getDb().select().from(approvals)).toHaveLength(0);
    expect(await getDb().select().from(payments)).toHaveLength(0);
    expect(await moneyMoved()).toEqual(ZERO_MONEY);

    recordGuarded("A7", {
      case: "trigger's draft far over caps (400 crates): refused with anomaly flag",
      decision: "REFUSE",
      reasonCodes: ["REFUSE_CAP", "TRIGGER_ORIGIN"],
      ledger: ["PROPOSAL_CREATED"],
    });
  });

  it("even under AUTOPILOT the trigger cannot approve: no mandate means ASK, flagged TRIGGER_ORIGIN", async () => {
    const { userId, supplier } = await setup("AUTOPILOT");
    const p = await proposeOrder({ userId, createdBy: "AGENT", triggerOrigin: true, ...trigger(supplier.id, 40) });
    expect(p.decision).toBe("ASK");
    expect(p.reasonCodes).toContain("TRIGGER_ORIGIN");
    expect(await getDb().select().from(approvals)).toHaveLength(0);
    expect(await getDb().select().from(payments)).toHaveLength(0);
    expect(await moneyMoved()).toEqual(ZERO_MONEY);

    recordGuarded("A7", {
      case: "AUTOPILOT: trigger's 10x draft still needs the user",
      decision: "ASK",
      reasonCodes: p.reasonCodes,
      ledger: ["PROPOSAL_CREATED"],
      ifApproved: { paysAttacker: false, note: "The verified supplier is paid for 10x the usual order: an overpayment, not money to the attacker." },
    });
  });
});
