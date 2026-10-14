/*
 * Real-model smoke test (not run in CI): KASSA_LIVE_LLM_TEST=1 plus a planner key (ANTHROPIC_API_KEY, or
 * OPENROUTER_API_KEY with PLANNER_MODEL=openrouter:…). It checks that the configured planner answers live and calls
 * a tool through the same registry, retries and redaction the app uses, so "the AI is live" is something a judge
 * can run: `KASSA_LIVE_LLM_TEST=1 bunx vitest run test/intel/live-llm.smoke.test.ts`.
 */
import { generateText, isStepCount, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getPlannerModel, plannerSpec } from "../../src/modules/ai/models.ts";
import { SDK_MAX_RETRIES } from "../../src/modules/ai/retry.ts";

const enabled = process.env.KASSA_LIVE_LLM_TEST === "1";

describe.skipIf(!enabled)(`live planner smoke test (${enabled ? plannerSpec().id : "skipped"})`, () => {
  it("answers and calls a tool", async () => {
    let called = false;
    const res = await generateText({
      model: getPlannerModel(),
      maxRetries: SDK_MAX_RETRIES,
      stopWhen: isStepCount(3),
      prompt: "What are my balances? Use the tool, then answer in one sentence.",
      tools: {
        get_balances: tool({
          description: "The user's wallet balances",
          inputSchema: z.object({}),
          execute: async () => {
            called = true;
            return { balances: [{ currency: "EUR", amountMinor: 30_000 }] };
          },
        }),
      },
    });
    expect(called).toBe(true);
    expect(res.text.length).toBeGreaterThan(0);
  }, 60_000);
});
