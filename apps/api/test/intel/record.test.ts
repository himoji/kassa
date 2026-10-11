import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { streamText, tool, wrapLanguageModel, isStepCount } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { loadRecording, replayModel, selectTurn, StepRecorder } from "../../src/modules/agent/replay.ts";

describe("RECORD=1 → fixtures/agent-recordings/<scenario>.json → REPLAY", () => {
  it("records each model step (text + tool calls) and replays the same turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kassa-rec-"));
    try {
      const live = replayModel({ userText: "x", match: [], steps: [{ text: "Checking.", toolCalls: [{ toolName: "echo", input: { v: 1 } }] }, { text: "Done." }] });
      const rec = new StepRecorder();
      const model = wrapLanguageModel({ model: live as Exclude<typeof live, string>, middleware: rec.middleware() });
      const r = streamText({ model, prompt: "hello payee_1", tools: { echo: tool({ inputSchema: z.object({ v: z.number() }), execute: async ({ v }) => ({ v }) }) }, stopWhen: isStepCount(3) });
      await r.consumeStream();
      expect(rec.steps).toEqual([{ text: "Checking.", toolCalls: [{ toolName: "echo", input: { v: 1 } }] }, { text: "Done." }]);
      rec.save("Demo Scenario", "hello payee_1", "test:model", dir);
      const loaded = loadRecording("demo-scenario", dir);
      expect(loaded?.turns).toHaveLength(1);
      expect(selectTurn("Hello  PAYEE_1", { dir }).turn.steps).toHaveLength(2);
      // Re-recording the same user text replaces the turn instead of duplicating it.
      rec.save("Demo Scenario", "hello payee_1", "test:model", dir);
      expect(loadRecording("demo-scenario", dir)?.turns).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the shipped tuition recording is valid and selectable by keyword", () => {
    const { recording, turn } = selectTurn("please pay the TUITION now");
    expect(recording.scenario).toBe("tuition");
    expect(turn.steps.flatMap((s) => s.toolCalls ?? []).map((c) => c.toolName)).toContain("propose_order");
  });
});
