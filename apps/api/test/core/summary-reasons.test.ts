/*
 * Plain-language summaries: the order summary ends with the shared reasonsSentenceEn(codes) sentence (the codes stay
 * next to their text), while the structured reasonCodes field is unchanged.
 */
import { reasonsSentenceEn } from "@kassa/shared";
import { beforeEach, describe, expect, it } from "vitest";

import { proposeOrder } from "../../src/modules/rules/index.ts";
import { setSanctionsListForTests } from "../../src/modules/screening/index.ts";
import { addPayee, createUserWithPasskey, IBAN_UNIVERSITY, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();

describe("order summary uses the shared reasons sentence", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setSanctionsListForTests([]);
  });

  it("summary ends with reasonsSentenceEn(codes); reasonCodes stay structured", async () => {
    const { userId, auth } = await createUserWithPasskey();
    await signBaseRules(userId, auth);
    const university = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY });
    const r = await proposeOrder({ userId, createdBy: "USER", payeeId: university.id, amountMinor: 50_000_000, currency: "EUR", purpose: "Tuition" });
    expect(r.reasonCodes.length).toBeGreaterThan(0);
    expect(r.summary.endsWith(reasonsSentenceEn(r.reasonCodes))).toBe(true);
    expect(r.summary).toContain(`(${r.reasonCodes[0]})`);
    expect(r.summary).not.toContain(`Reasons: ${r.reasonCodes.join(", ")}.`);
  });
});
