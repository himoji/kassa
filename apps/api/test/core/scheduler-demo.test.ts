/* Scheduler (spec §15) + demo routes: seed → +3 days → rent autopay inside a signed mandate. */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { obligations, payments, proposals } from "../../src/db/schema.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { addMonths, proposeDueObligations, tick } from "../../src/modules/scheduler/index.ts";
import { useTestApp } from "../helpers/app.ts";
import { addActiveMandate, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";
import { SoftAuthenticator } from "../helpers/webauthn.ts";
import { webauthnCredentialsPayments, webauthnCredentialsRules } from "../../src/db/schema.ts";

const t = useTestDb();
const app = useTestApp();

describe("scheduler + demo", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  it("addMonths clamps to month length (ISO 8601 dates)", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-11-01", 1)).toBe("2026-12-01");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
  });

  it("seed sets Clock.now() to SEED_NOW; GET /demo/clock reports it", async () => {
    const data = await loadSeedData();
    await seedDatabase(getDb(), data, { reset: true });
    expect(Math.abs(clock.nowMs() - Date.parse(data.seedNow))).toBeLessThan(5000);
    const res = await app().inject({ method: "GET", url: "/api/demo/clock" });
    expect(res.statusCode).toBe(200);
    expect(Math.abs(Date.parse(res.json().now) - Date.parse(data.seedNow))).toBeLessThan(5000);
  });

  it("rent: +3 days → scheduler proposal → AUTO under the signed mandate; idempotent; rolls monthly", async () => {
    const data = await loadSeedData();
    const { userId } = await seedDatabase(getDb(), data, { reset: true });
    const auth = new SoftAuthenticator();
    const row = { userId, credentialId: auth.id, publicKey: auth.publicKeyB64u(), counter: 0, transports: ["internal"] };
    await getDb().insert(webauthnCredentialsRules).values(row);
    await getDb().insert(webauthnCredentialsPayments).values(row);
    await signBaseRules(userId, auth);
    const rentPayee = data.payees.find((p) => p.kind === "LANDLORD")!;
    await addActiveMandate(userId, auth, { payeeIds: [rentPayee.id], categories: ["rent"], currency: "HUF", maxPerPaymentMinor: 20_000_000, maxPerPeriodMinor: 20_000_000 });

    expect(await proposeDueObligations()).toBe(0); // rent due in 5 days, tuition in 4: outside the 3-day window

    const res = await app().inject({ method: "POST", url: "/api/demo/clock/advance", payload: { hours: 72 } });
    expect(res.statusCode).toBe(200);
    const rent = (await getDb().select().from(proposals).where(eq(proposals.category, "rent")))[0]!;
    expect(rent.decision).toBe("AUTO");
    expect(rent.createdBy).toBe("SCHEDULER");
    expect(rent.status).toBe("EXECUTED");
    const all = await getDb().select().from(proposals);
    const tuition = all.find((p) => p.category === "tuition");
    expect(tuition?.decision).toBe("ASK");
    expect(await getDb().select().from(payments)).toHaveLength(1);

    await tick();
    const rentOb = (await getDb().select().from(obligations).where(eq(obligations.payeeId, rentPayee.id)))[0]!;
    expect(rentOb.dueDate).toBe(addMonths(data.obligations.find((o) => o.payeeId === rentPayee.id)!.dueDate, 1));
    expect(await getDb().select().from(payments)).toHaveLength(1);
  });
});
