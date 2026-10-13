import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ChoiceError } from "../../src/modules/agent/choices.ts";
import { loadHistory } from "../../src/modules/agent/history.ts";
import { replayModel } from "../../src/modules/agent/replay.ts";
import { budgetPairs, fallbackPicker } from "../../src/modules/onboarding/pickers.ts";
import { onboardingTurn } from "../../src/modules/onboarding/service.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey } from "../helpers/fixtures.ts";
import { ensureIntelTables } from "./intelTables.ts";

/* Buttons the onboarding chat shows when the model asks in prose only (onboarding/pickers.ts). */

const t = useTestDb();

const draft = { displayName: null, homeCurrency: null, region: null, preset: null, moneyMode: null, notificationMode: null, incomes: [], obligations: [], budgets: [], cards: [] };
const step = (out: unknown) => replayModel({ userText: "", match: [], steps: [{ text: JSON.stringify(out) }] });
const BUDGETS =
  "Now the last thing to make this live: monthly budgets in ₸. Rough idea to hit your $3,700 goal — groceries 150000, transport 30000, eating out 60000, fun 40000, other 40000? Tell me your numbers and I'll set them.";

describe("onboarding fallback pickers", () => {
  it("reads the category amounts a reply proposes, not the goal", () => {
    expect(budgetPairs(BUDGETS)).toEqual([
      { id: "groceries", label: "Groceries", amount: 150000 },
      { id: "transport", label: "Transport", amount: 30000 },
      { id: "eating_out", label: "Eating out", amount: 60000 },
      { id: "fun", label: "Fun", amount: 40000 },
      { id: "other", label: "Other", amount: 40000 },
    ]);
    expect(budgetPairs("- Groceries: 150,000 ₸\n- Transport: 30k\n- Rent 2.500,00")).toEqual([
      { id: "groceries", label: "Groceries", amount: 150000 },
      { id: "transport", label: "Transport", amount: 30000 },
      { id: "rent", label: "Rent", amount: 2500 },
    ]);
  });

  it("preset and notification questions get buttons, only while the draft lacks them", () => {
    const preset = fallbackPicker("How hands-off should I be: **Ask me**, **Smart** or **Autopilot**?", draft, "ob_1");
    expect(preset?.options.map((o) => o.label)).toEqual(["Ask me", "Smart", "Autopilot"]);
    expect(fallbackPicker("Smart or Autopilot?", { ...draft, preset: "SMART" }, "ob_1")).toBeNull();
    const notif = fallbackPicker("Great, Smart it is. How should I notify you: each payment, above thresholds, or a daily digest?", { ...draft, preset: "SMART" }, "ob_2");
    expect(notif?.options.map((o) => o.label)).toEqual(["Each payment", "Above thresholds", "Daily digest"]);
    expect(fallbackPicker("Nice to meet you!", draft, "ob_3")).toBeNull();
  });

  it("a budgets reply becomes one amounts card; all values are answered at once and validated", async () => {
    await ensureIntelTables(t.db());
    const { userId } = await createUserWithPasskey();
    const conversationId = randomUUID();
    const kzt = { ...draft, homeCurrency: "KZT" };
    const first = await onboardingTurn({ userId, conversationId, text: "ok", mode: "LIVE", model: step({ reply: BUDGETS, draft: kzt, complete: false, ask: null }) });
    const part = first.ui[0]!;
    expect(part.kind).toBe("amounts");
    expect(part.amounts?.currency).toBe("KZT");
    expect(part.amounts?.items.map((i) => [i.id, i.emoji, i.defaultMinor])).toEqual([
      ["groceries", "🛒", 15000000],
      ["transport", "🚌", 3000000],
      ["eating_out", "🍽️", 6000000],
      ["fun", "🎉", 4000000],
      ["other", "📦", 4000000],
    ]);

    await expect(
      onboardingTurn({ userId, conversationId, text: "x", choice: { id: part.id, values: [{ id: "rent", value: "100" }] }, mode: "LIVE", model: step({ reply: "?", draft: kzt, complete: false }) }),
    ).rejects.toBeInstanceOf(ChoiceError);

    await onboardingTurn({
      userId,
      conversationId,
      text: "budgets",
      choice: { id: part.id, values: [{ id: "groceries", value: "12000000" }, { id: "fun", value: "0" }] },
      mode: "LIVE",
      model: step({ reply: "Set.", draft: kzt, complete: false }),
    });
    const history = await loadHistory(conversationId, userId);
    expect(JSON.stringify(history.at(-2))).toContain("User: Groceries 120000.00 KZT, Transport 30000.00 KZT, Eating out 60000.00 KZT, Fun 0.00 KZT, Other 40000.00 KZT");
  });

  it("the model's own amounts ask (major units) becomes the same card", async () => {
    await ensureIntelTables(t.db());
    const { userId } = await createUserWithPasskey();
    const ask = { kind: "amounts", prompt: "Budgets?", currency: "EUR", items: [{ id: "groceries", label: "Groceries", emoji: "🥦", amount: 250 }] };
    const res = await onboardingTurn({ userId, conversationId: randomUUID(), text: "ok", mode: "LIVE", model: step({ reply: "Budgets:", draft, complete: false, ask }) });
    expect(res.ui[0]?.amounts?.items[0]).toMatchObject({ id: "groceries", emoji: "🥦", defaultMinor: 25000 });
  });
});
