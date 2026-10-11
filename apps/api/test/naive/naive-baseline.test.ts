/*
 * Naive baseline (spec §19). Each attack A1..A8 is run as the agent's RAW intent through a stub rail with no rules,
 * payments verification, Reader, screening, caps, cooling or webhook checks. Every case must pay: that is the
 * baseline the guarded counterparts test/attacks/A1..A8 are measured against. No DB, no HTTP.
 * Evidence is written only with WRITE_EVIDENCE=1 (root `bun run evidence:attacks`).
 */
import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_CAPS } from "../../src/modules/users/service.ts";
import { ATTACKS, recordNaive, writeNaiveBaseline, type AttackId } from "../helpers/attacks.ts";
import { naiveExecute, naiveIntents, StubRail, type NaiveResult, type RawIntent } from "./harness.ts";

const ids = Object.keys(ATTACKS) as AttackId[];
const intents = naiveIntents({ perPaymentMinor: DEFAULT_CAPS.perPaymentMinor });
const results: Partial<Record<AttackId, NaiveResult & { intent: RawIntent }>> = {};

describe("naive baseline: the raw intent of every attack pays through a stub rail", () => {
  it.each(ids)("%s pays exactly the intended payment", async (id) => {
    const intent = intents[id];
    const rail = new StubRail();
    const r = await naiveExecute(intent, rail);
    results[id] = r;
    expect(r.paid).toBe(true);
    expect(rail.calls).toEqual([{ payeeName: intent.payeeName, account: intent.account, amountMinor: intent.amountMinor, currency: intent.currency }]);
  });

  it("8 of 8 raw intents pay", () => {
    expect(ids.map((id) => results[id]?.paid === true)).toEqual(ids.map(() => true));
    expect(ids.filter((id) => results[id]?.paid)).toHaveLength(8);
  });

  it("the harness imports nothing from the guarded modules (rules, payments, reader, screening, webhooks, users)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./harness.ts", import.meta.url), "utf8");
    const specifiers = [...src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    const banned = specifiers.filter((s) => /src\/modules\/(rules|payments|reader|screening|webhooks|users)(\/|\.ts$|$)/.test(s));
    expect(banned).toEqual([]);
  });
});

afterAll(() => {
  for (const id of ids) {
    const r = results[id];
    if (r) recordNaive(id, { outcome: r.outcome, paid: r.paid, railCalls: r.railCalls, detail: r.detail });
  }
  if (ids.every((id) => results[id])) writeNaiveBaseline(results as Record<AttackId, NaiveResult & { intent: RawIntent }>);
});
