import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

import { getDb } from "../../src/db/client.ts";
import { payments, proposals } from "../../src/db/schema.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { addActiveMandate, addPayee, createUserWithPasskey, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();

describe("end-to-end money path", () => {
  let env: ReturnType<typeof offlineEnvironment>;
  beforeEach(async () => {
    await t.reset();
    env = offlineEnvironment();
  });

  it("T2: propose → ASK → passkey approve → payment", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const payee = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR" });
    const r = await proposeOrder({ userId, createdBy: "AGENT", payeeId: payee.id, amountMinor: 240_000, currency: "EUR", purpose: "Tuition" });
    expect(r.decision).toBe("ASK");
    const view = await getOrderView(userId, r.proposalId);
    expect(view.webauthnOptions?.challenge).toBe(view.orderHash);
    const res = await approveOrder(userId, r.proposalId, auth.assert(view.orderHash));
    expect(res.reasonCodes).toEqual([]);
    expect(res.paymentStatus).toBe("PROCESSING");
    expect(env.railCalls).toHaveLength(1);
    const p = (await getDb().select().from(proposals).where(eq(proposals.id, r.proposalId)))[0]!;
    expect(p.status).toBe("EXECUTED");
  });

  it("T1: mandate → AUTO → payment without passkey prompt", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const payee = await addPayee(userId, { name: "Landlord in Budapest" });
    await signBaseRules(userId, auth);
    await addActiveMandate(userId, auth, { payeeIds: [payee.id], categories: ["rent"], currency: "HUF", maxPerPaymentMinor: 20_000_000, maxPerPeriodMinor: 20_000_000 });
    const r = await proposeOrder({ userId, createdBy: "SCHEDULER", payeeId: payee.id, amountMinor: 18_000_000, currency: "HUF", purpose: "Rent", category: "rent" });
    expect(r.decision).toBe("AUTO");
    expect(r.reasonCodes).toContain("MANDATE_MATCH");
    const rows = await getDb().select().from(payments).where(eq(payments.proposalId, r.proposalId));
    expect(rows[0]?.status).toBe("PROCESSING");
  });
});
