/*
 * Naive baseline (spec §19). Each attack (A1..A8, and the real-world incidents A10..A17) is run as the agent's RAW
 * intent through a stub rail with no rules, payments verification, Reader, screening, caps, cooling or webhook checks.
 * Every case must pay, by construction (there is not even a confirm tap): it is the upper bound, not a realistic
 * competitor; the fairer baseline is tap-confirm-baseline.test.ts. No DB, no HTTP. Evidence is written only with
 * WRITE_EVIDENCE=1 (root `bun run evidence:attacks`).
 */
import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_CAPS } from "../../src/modules/users/service.ts";
import { ATTACKS, recordNaive, writeNaiveBaseline, type AttackId } from "../helpers/attacks.ts";
import { naiveExecute, naiveIntents, StubRail, type NaiveResult, type RawIntent } from "./harness.ts";

const ids = Object.keys(ATTACKS) as AttackId[];
const intents = naiveIntents({ perPaymentMinor: DEFAULT_CAPS.perPaymentMinor });
const results: Partial<Record<AttackId, NaiveResult & { intent: RawIntent }>> = {};

describe("naive baseline: the raw intent of every attack pays through a stub rail", () => {
  it("covers every attack in the suite: A1..A8 and the real-world incidents A10..A17", () => {
    expect(ids).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A10", "A11", "A12", "A13", "A14", "A15", "A16", "A17"]);
  });

  it.each(ids)("%s pays exactly the intended payment", async (id) => {
    const intent = intents[id];
    const rail = new StubRail();
    const r = await naiveExecute(intent, rail);
    results[id] = r;
    expect(r.paid).toBe(true);
    const one = { payeeName: intent.payeeName, account: intent.account, amountMinor: intent.amountMinor, currency: intent.currency };
    expect(rail.calls).toEqual(Array(intent.repeat ?? 1).fill(one));
  });

  it(`${ids.length} of ${ids.length} raw intents pay`, () => {
    expect(ids.map((id) => results[id]?.paid === true)).toEqual(ids.map(() => true));
    expect(ids.filter((id) => results[id]?.paid)).toHaveLength(16);
  });

  it("the harnesses import nothing from the guarded modules (rules, payments, reader, screening, webhooks, users)", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["./harness.ts", "./tap-confirm.ts", "../helpers/incidents.ts"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      const specifiers = [...src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)].map((m) => m[1]!);
      expect(specifiers.length).toBeGreaterThan(0);
      const banned = specifiers.filter((s) => /src\/modules\/(rules|payments|reader|screening|webhooks|users)(\/|\.ts$|$)/.test(s));
      expect(banned).toEqual([]);
    }
  });
});

afterAll(() => {
  for (const id of ids) {
    const r = results[id];
    if (r) recordNaive(id, { outcome: r.outcome, paid: r.paid, railCalls: r.railCalls, detail: r.detail });
  }
  if (ids.every((id) => results[id])) writeNaiveBaseline(results as Record<AttackId, NaiveResult & { intent: RawIntent }>);
});
