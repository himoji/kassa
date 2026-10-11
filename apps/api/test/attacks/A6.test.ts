/* A6 — transfer to a sanctions-listed name (incl. transliteration). Expected: REFUSE_SANCTIONS, no payment, ledgered. */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { ledgerEntries, payments } from "../../src/db/schema.ts";
import { proposeOrder } from "../../src/modules/rules/index.ts";
import { loadSanctions, setSanctionsListForTests } from "../../src/modules/screening/index.ts";
import { addPayee, createUserWithPasskey, IBAN_OTHER, offlineEnvironment } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();

describe("A6: sanctions screening before bank transfers", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setSanctionsListForTests(loadSanctions()); // fixtures/sanctions-sample.json (Track D)
  });

  it.each([
    ["exact Latin alias", "Sviatoslav Igorevich Kassov"],
    ["Cyrillic original", "Святослав Кассов"],
    ["transliteration variant", "Svyatoslav Kassov"],
    ["fuzzy + word order", "Kasov Sviatoslav"],
    ["entity with legal suffix", "Northwind Arms Trading OOO"],
  ])("%s → REFUSE_SANCTIONS", async (_label, name) => {
    const { userId } = await createUserWithPasskey();
    const payee = await addPayee(userId, { name, kind: "PERSON", account: IBAN_OTHER });
    const r = await proposeOrder({ userId, createdBy: "AGENT", payeeId: payee.id, amountMinor: 1_000_000, currency: "HUF", purpose: "transfer", rail: "BANK_TRANSFER" });
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toEqual(["REFUSE_SANCTIONS"]);
    expect(await getDb().select().from(payments)).toHaveLength(0);
    const entry = (await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "PROPOSAL_CREATED")))[0]!;
    expect((entry.payload as { reasonCodes: string[] }).reasonCodes).toEqual(["REFUSE_SANCTIONS"]);
  });

  it("a normal payee is not a hit", async () => {
    const { userId } = await createUserWithPasskey();
    const payee = await addPayee(userId, { name: "Hillside Flats Kft.", account: IBAN_OTHER });
    const r = await proposeOrder({ userId, createdBy: "AGENT", payeeId: payee.id, amountMinor: 1_000_000, currency: "HUF", purpose: "rent", rail: "BANK_TRANSFER" });
    expect(r.reasonCodes).not.toContain("REFUSE_SANCTIONS");
  });
});
