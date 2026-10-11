import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { OnboardingMessageResponse } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { budgets, cards, profiles } from "../../src/db/schema.ts";
import { mintAccessTokenForTests } from "../../src/modules/auth/session.ts";
import { applyOnboardingDraft, getOnboardingDraft } from "../../src/modules/onboarding/index.ts";
import { readUntrusted } from "../../src/modules/reader/reader.ts";
import { buildServer } from "../../src/server.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey } from "../helpers/fixtures.ts";
import { ensureIntelTables } from "./intelTables.ts";

const t = useTestDb();
const rec = JSON.parse(readFileSync(new URL("../../../../fixtures/agent-recordings/onboarding.json", import.meta.url), "utf8")) as {
  turns: Array<{ userText: string; steps: Array<{ text: string }> }>;
};
const savedEnv = { AGENT_MODE: process.env.AGENT_MODE, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };

beforeAll(async () => {
  await ensureIntelTables(t.db());
  process.env.AGENT_MODE = "REPLAY";
  delete process.env.ANTHROPIC_API_KEY;
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("onboarding chat in REPLAY (no API key)", () => {
  it("runs Dana's four turns over HTTP and ends with a complete draft matching the seed", async () => {
    const { userId } = await createUserWithPasskey();
    const token = await mintAccessTokenForTests(userId);
    const app = await buildServer({ logger: false });
    const conversationId = randomUUID();
    try {
      const replies: OnboardingMessageResponse[] = [];
      for (const turn of rec.turns) {
        const res = await app.inject({
          method: "POST",
          url: "/api/onboarding/message",
          headers: { authorization: `Bearer ${token}` },
          payload: { conversationId, text: turn.userText },
        });
        expect(res.statusCode, res.body).toBe(200);
        replies.push(OnboardingMessageResponse.parse(res.json()));
      }
      expect(replies.map((r) => r.complete)).toEqual([false, false, false, true]);
      const d = replies[3]!.draft;
      expect(d).toMatchObject({ displayName: "Dana", homeCurrency: "KZT", region: "EU", preset: "SMART", moneyMode: "CAPPED_WALLET", notificationMode: "EACH" });
      expect(d.incomes).toEqual([
        { source: "Parents", currency: "KZT", amountMinor: 60000000, cadence: "MONTHLY", nextDate: "2026-11-25" },
        { source: "Scholarship", currency: "USD", amountMinor: 40000, cadence: "MONTHLY", nextDate: "2026-11-01" },
      ]);
      expect(d.obligations.map((o) => [o.category, o.amountMinor, o.currency, o.dueDate, o.recurrence])).toEqual([
        ["rent", 18000000, "HUF", "2026-11-01", "MONTHLY"],
        ["tuition", 240000, "EUR", "2026-10-31", "TERM"],
        ["insurance", 9600, "EUR", "2026-11-15", "TERM"],
      ]);
      expect(d.budgets).toEqual([
        { category: "groceries", limitHomeMinor: 9000000 },
        { category: "eating_out", limitHomeMinor: 6000000 },
        { category: "transport", limitHomeMinor: 2000000 },
      ]);
      expect(d.cards.map((c) => c.last4)).toEqual(["4821", "7310", "0596"]);

      // Persisted draft is what A's /onboarding/confirm[/options] read; applying it writes the profile parts.
      expect(await getOnboardingDraft(userId, conversationId)).toEqual(d);
      await applyOnboardingDraft(userId, d);
      const p = (await t.db().select().from(profiles).where(eq(profiles.userId, userId)))[0]!;
      expect(p.incomes).toHaveLength(2);
      expect(await t.db().select().from(budgets).where(eq(budgets.userId, userId))).toHaveLength(3);
      expect(await t.db().select().from(cards).where(eq(cards.userId, userId))).toHaveLength(3);

      // Another user cannot continue this conversation; 404 (not 403) so the id's existence does not leak (OWASP API1).
      const other = await createUserWithPasskey();
      const res = await app.inject({
        method: "POST",
        url: "/api/onboarding/message",
        headers: { authorization: `Bearer ${await mintAccessTokenForTests(other.userId)}` },
        payload: { conversationId, text: "hi" },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe("Reader replay for the tuition invoice (fixtures/invoices/inv-01.pdf)", () => {
  it("serves the recorded extraction and still runs every evidence check", async () => {
    const pdf = new Uint8Array(readFileSync(new URL("../../../../fixtures/invoices/inv-01.pdf", import.meta.url)));
    const r = await readUntrusted("invoice", { type: "pdf", data: pdf }, { replay: true });
    expect(r.model).toBe("replay");
    expect(r.parsed).toEqual({ amountMinor: 240000, currency: "EUR", dueDate: "2026-10-31", account: "HU83118009905400221700000005" });
    expect(r.reasonCodes).toEqual([]);
  });
});
