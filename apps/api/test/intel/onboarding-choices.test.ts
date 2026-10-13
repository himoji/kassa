import { randomUUID } from "node:crypto";

import type { DataChoices } from "@kassa/shared";
import { describe, expect, it } from "vitest";

import { ChoiceError } from "../../src/modules/agent/choices.ts";
import { loadHistory } from "../../src/modules/agent/history.ts";
import { replayModel } from "../../src/modules/agent/replay.ts";
import { latestOnboardingConversation, onboardingTurn } from "../../src/modules/onboarding/service.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey } from "../helpers/fixtures.ts";
import { ensureIntelTables } from "./intelTables.ts";

/* Onboarding pickers (ask_choice in the structured turn): returned as `ui`, answers validated against the stored turn. */

const t = useTestDb();

const draft = { displayName: null, homeCurrency: null, region: null, preset: null, moneyMode: null, notificationMode: null, incomes: [], obligations: [], budgets: [], cards: [] };
const step = (out: unknown) => replayModel({ userText: "", match: [], steps: [{ text: JSON.stringify(out) }] });
const ask = {
  kind: "choice",
  prompt: "Your home currency?",
  options: [
    { id: "kzt", label: "Tenge (KZT)", spoken: ["tenge"] },
    { id: "eur", label: "Euro (EUR)", spoken: ["euro"] },
  ],
};

describe("onboarding pickers", () => {
  it("returns the picker as ui, validates the pick, and restores the chat with the answer", async () => {
    await ensureIntelTables(t.db());
    const { userId } = await createUserWithPasskey();
    const conversationId = randomUUID();
    const first = await onboardingTurn({ userId, conversationId, text: "Hi", mode: "LIVE", model: step({ reply: "Welcome! Which currency?", draft, complete: false, ask }) });
    expect(first.ui).toHaveLength(1);
    const part = first.ui[0] as DataChoices;
    expect(part).toMatchObject({ kind: "choice", prompt: "Your home currency?", options: [{ id: "kzt" }, { id: "eur" }] });

    await expect(onboardingTurn({ userId, conversationId, text: "x", choice: { id: part.id, optionId: "usd" }, mode: "LIVE", model: step({ reply: "?", draft, complete: false }) })).rejects.toBeInstanceOf(ChoiceError);
    await expect(onboardingTurn({ userId, conversationId, text: "x", choice: { id: "ob_forged", optionId: "kzt" }, mode: "LIVE", model: step({ reply: "?", draft, complete: false }) })).rejects.toBeInstanceOf(ChoiceError);

    const second = await onboardingTurn({ userId, conversationId, text: "Tenge", choice: { id: part.id, optionId: "kzt" }, mode: "LIVE", model: step({ reply: "Got it.", draft: { ...draft, homeCurrency: "KZT" }, complete: false, ask: null }) });
    expect(second.ui).toEqual([]);
    expect(second.draft.homeCurrency).toBe("KZT");
    const history = await loadHistory(conversationId, userId);
    expect(JSON.stringify(history.at(-2))).toContain("User: Tenge (KZT)");

    const restored = await latestOnboardingConversation(userId);
    expect(restored.conversationId).toBe(conversationId);
    expect(restored.draft?.homeCurrency).toBe("KZT");
    expect(restored.turns.map((x) => x.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(restored.turns[1]!.ui[0]!.answer).toEqual({ optionIds: ["kzt"], label: "Tenge (KZT)" });
  });

  it("free text matching a picker option (typed or spoken) becomes that option", async () => {
    await ensureIntelTables(t.db());
    const { userId } = await createUserWithPasskey();
    const conversationId = randomUUID();
    await onboardingTurn({ userId, conversationId, text: "Hi", mode: "LIVE", model: step({ reply: "Which currency?", draft, complete: false, ask }) });
    await onboardingTurn({ userId, conversationId, text: "euro", mode: "LIVE", model: step({ reply: "Ok", draft, complete: false }) });
    expect(JSON.stringify((await loadHistory(conversationId, userId)).at(-2))).toContain("User: Euro (EUR)");
  });
});
