/*
 * Chatbot + tap-to-confirm baseline (test/naive/tap-confirm.ts): the same raw intents as the naive baseline, through
 * an agent whose payment tool needs one user tap per payment and has no other check. With a fooled user who taps every
 * card, every attack pays; with a careful user who declines, only A3 does (a forged confirmation: nothing signs it).
 * No DB, no HTTP, no AI. Evidence is written only with WRITE_EVIDENCE=1 (root `bun run evidence:attacks`).
 */
import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_CAPS } from "../../src/modules/users/service.ts";
import { ATTACKS, recordTap, writeTapBaseline, type AttackId, type TapResult } from "../helpers/attacks.ts";
import { naiveIntents } from "./harness.ts";
import { CAREFUL_USER, FOOLED_USER, runTapAttack, TAP_NOTES } from "./tap-confirm.ts";

const ids = Object.keys(ATTACKS) as AttackId[];
const intents = naiveIntents({ perPaymentMinor: DEFAULT_CAPS.perPaymentMinor });
const results: Partial<Record<AttackId, TapResult>> = {};

describe("tap-to-confirm baseline: a confirm tap and no rules", () => {
  it.each(ids)("%s with a fooled user who taps, and with a careful user who declines", async (id) => {
    const intent = intents[id];
    const fooled = await runTapAttack(intent, FOOLED_USER);
    const careful = await runTapAttack(intent, CAREFUL_USER);
    const times = intent.repeat ?? 1;
    const paid = fooled.railCalls > 0;
    const carefulUserPaid = careful.railCalls > 0;
    results[id] = {
      outcome: paid ? "PAID" : "REFUSED",
      paid,
      railCalls: fooled.railCalls,
      taps: fooled.taps,
      paidOnlyBecauseUserTapped: paid && !carefulUserPaid,
      carefulUserPaid,
      toAttacker: TAP_NOTES[id].toAttacker,
      detail: `${intent.payeeName} received ${intent.amountMinor} ${intent.currency} (minor units)${times > 1 ? ` × ${times}` : ""}; ${fooled.taps} tap(s)`,
      note: TAP_NOTES[id].note,
    };

    if (id === "A3") {
      // Direct call refused, forged confirmation paid, replay refused; no tap either way.
      expect(fooled.statuses).toEqual(["NO_CONFIRMATION", "SENT", "ALREADY_EXECUTED"]);
      expect(careful.statuses).toEqual(fooled.statuses);
      expect(fooled.taps).toBe(0);
      expect(fooled.railCalls).toBe(1);
      expect(carefulUserPaid).toBe(true);
    } else {
      expect(fooled.statuses).toEqual(Array(times).fill("SENT"));
      expect(fooled.taps).toBe(times);
      expect(fooled.railCalls).toBe(times);
      // The tap is the only gate: the careful user stops every one of them.
      expect(careful.statuses).toEqual(Array(times).fill("DECLINED"));
      expect(carefulUserPaid).toBe(false);
    }
  });

  it("every attack pays with the fooled user; 15 only because the user tapped, A3 without any tap", () => {
    expect(ids.filter((id) => results[id]?.paid)).toHaveLength(16);
    expect(ids.filter((id) => results[id]?.paidOnlyBecauseUserTapped)).toEqual(ids.filter((id) => id !== "A3"));
    expect(ids.filter((id) => results[id]?.carefulUserPaid)).toEqual(["A3"]);
  });

  it("has a note for every attack", () => {
    expect(Object.keys(TAP_NOTES).sort()).toEqual([...ids].sort());
  });
});

afterAll(() => {
  for (const id of ids) {
    const r = results[id];
    if (r) recordTap(id, r);
  }
  if (ids.every((id) => results[id])) writeTapBaseline(results as Record<AttackId, TapResult>);
});
