/*
 * Y2 (p2 B1, B2): the demo seed must not grant AI consent unless the caller asks (GDPR Art. 7: consent is given
 * deliberately), and the seed's ledger entries are per user so a user's export never names another persona.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { IDS, LI_WEI_IDS } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { users } from "../../src/db/schema.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { exportUserData } from "../../src/modules/privacy/service.ts";
import { useTestDb } from "../helpers/db.ts";

useTestDb();

async function consentOf(userId: string): Promise<Date | null> {
  return (await getDb().select({ at: users.aiConsentAt }).from(users).where(eq(users.id, userId)))[0]!.at;
}

describe("demo seed and AI consent (Y2, p2 B1)", () => {
  it("seeded users have no AI consent by default", async () => {
    const { userId, personaUserIds } = await seedDatabase(getDb(), await loadSeedData(), { reset: true, personas: true });
    expect(await consentOf(userId)).toBeNull();
    for (const id of personaUserIds) expect(await consentOf(id)).toBeNull();
  });

  it("tests can opt in with { aiConsent: true }", async () => {
    const { userId, personaUserIds } = await seedDatabase(getDb(), await loadSeedData(), { reset: true, personas: true, aiConsent: true });
    expect(await consentOf(userId)).toBeInstanceOf(Date);
    for (const id of personaUserIds) expect(await consentOf(id)).toBeInstanceOf(Date);
  });
});

describe("demo seed ledger entries are per user (Y2, p2 B2)", () => {
  it("Dana's export contains no Li Wei identifiers, and Li Wei's none of Dana's", async () => {
    const data = await loadSeedData();
    await seedDatabase(getDb(), data, { reset: true, personas: true });
    const li = data.personas!.find((p) => p.user.id === LI_WEI_IDS.user)!;

    const dana = JSON.stringify(await exportUserData(IDS.user));
    expect(dana).not.toContain(LI_WEI_IDS.user);
    expect(dana).not.toContain(li.persona);
    expect(dana).not.toContain(li.user.displayName);
    for (const p of li.payees) expect(dana).not.toContain(p.id);

    const liExport = JSON.stringify(await exportUserData(LI_WEI_IDS.user));
    expect(liExport).not.toContain(IDS.user);
    expect(liExport).not.toContain(data.user.displayName);
    // Each user still sees their own seed entry.
    expect(liExport).toContain("DEMO_SEEDED");
    expect(dana).toContain("DEMO_SEEDED");
  });
});
