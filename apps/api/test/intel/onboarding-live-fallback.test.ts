import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { OnboardingMessageResponse } from "@kassa/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resetStructuredCapabilityCache } from "../../src/modules/ai/structured.ts";
import { mintAccessTokenForTests } from "../../src/modules/auth/session.ts";
import { buildServer } from "../../src/server.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey } from "../helpers/fixtures.ts";
import { ensureIntelTables } from "./intelTables.ts";

/*
 * Onboarding LIVE against an in-process OpenAI-compatible stub (127.0.0.1, no internet) that behaves
 * like the OpenRouter model from the 2026-10-11 smoke run: response_format → 400 "does not support
 * feature: structured-outputs", every other call first answers 429, tool calling works.
 * Plus the REPLAY path for a brand-new (non-Dana) account.
 */

const t = useTestDb();
const ENV_KEYS = ["AGENT_MODE", "PLANNER_MODEL", "LOCAL_BASE_URL", "LOCAL_API_KEY", "AI_MAX_RETRIES", "AI_STRUCTURED_MODE", "AI_REPLAY_FALLBACK"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let stub: Server;
let baseUrl = "";
const seen: Array<{ responseFormat: boolean; tools: string[]; status: number }> = [];
let behaviour: "openrouter-like" | "down" = "openrouter-like";
let calls = 0;

const draft = { displayName: null, homeCurrency: "KZT", region: "EU", preset: null, moneyMode: null, notificationMode: null, incomes: [], obligations: [], budgets: [], cards: [] };

beforeAll(async () => {
  await ensureIntelTables(t.db());
  stub = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const j = JSON.parse(body) as { response_format?: unknown; tools?: Array<{ function: { name: string } }> };
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        seen.push({ responseFormat: j.response_format !== undefined, tools: (j.tools ?? []).map((x) => x.function.name), status });
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };
      calls++;
      if (behaviour === "down") return send(503, { error: { message: "upstream unavailable" } });
      if (j.response_format) return send(400, { error: { message: "inclusionai/ling: does not support feature: structured-outputs", code: 400 } });
      if (calls % 2 === 0) return send(429, { error: { message: "rate limited upstream" } }, { "retry-after-ms": "5" });
      const tool = j.tools?.[0]?.function.name;
      const args = JSON.stringify({ reply: "Nice to meet you! Where does your money come from?", draft, complete: false });
      send(200, {
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [{ index: 0, message: tool ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: tool, arguments: args } }] } : { role: "assistant", content: args }, finish_reason: tool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

afterEach(() => {
  seen.length = 0;
  calls = 0;
  behaviour = "openrouter-like";
  resetStructuredCapabilityCache();
});

async function say(app: Awaited<ReturnType<typeof buildServer>>, token: string, conversationId: string, text: string) {
  return app.inject({ method: "POST", url: "/api/onboarding/message", headers: { authorization: `Bearer ${token}` }, payload: { conversationId, text } });
}

describe("onboarding LIVE on a model without structured output and a throttled upstream", () => {
  it("falls back to the forced tool call, retries the 429s, and completes two turns", async () => {
    process.env.AGENT_MODE = "LIVE";
    process.env.PLANNER_MODEL = "local:inclusionai/ling-stub";
    process.env.LOCAL_BASE_URL = baseUrl;
    process.env.LOCAL_API_KEY = "test-key";
    process.env.AI_MAX_RETRIES = "3";
    delete process.env.AI_STRUCTURED_MODE;
    const { userId } = await createUserWithPasskey();
    const token = await mintAccessTokenForTests(userId);
    const app = await buildServer({ logger: false });
    try {
      const conversationId = randomUUID();
      for (const text of ["Hi, I study in Budapest and my home currency is tenge", "My parents send money monthly"]) {
        const res = await say(app, token, conversationId, text);
        expect(res.statusCode, res.body).toBe(200);
        const body = OnboardingMessageResponse.parse(res.json());
        expect(body.draft.homeCurrency).toBe("KZT");
        expect(body.replay).toBe(false);
      }
      // Turn 1: native 400 → tool (429, retried, then 200). Turn 2: cached tool mode, no response_format.
      expect(seen.filter((s) => s.responseFormat)).toHaveLength(1);
      expect(seen.filter((s) => s.status === 429).length).toBeGreaterThanOrEqual(1);
      expect(seen.filter((s) => s.status === 200).every((s) => s.tools.length === 1)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("a provider outage is served from the recording, labelled replay", async () => {
    behaviour = "down";
    process.env.AI_MAX_RETRIES = "1";
    delete process.env.AI_REPLAY_FALLBACK;
    const { userId } = await createUserWithPasskey();
    const token = await mintAccessTokenForTests(userId);
    const app = await buildServer({ logger: false });
    try {
      const res = await say(app, token, randomUUID(), "Hi");
      expect(res.statusCode, res.body).toBe(200);
      expect(OnboardingMessageResponse.parse(res.json()).replay).toBe(true);
      expect(seen).toHaveLength(2); // the live call and its one retry, then the recording
    } finally {
      await app.close();
    }
  });

  it("with the fallback off, a provider outage is a clean 503 AI_PROVIDER_UNAVAILABLE, not a 500", async () => {
    behaviour = "down";
    process.env.AI_MAX_RETRIES = "1";
    process.env.AI_REPLAY_FALLBACK = "false";
    const { userId } = await createUserWithPasskey();
    const token = await mintAccessTokenForTests(userId);
    const app = await buildServer({ logger: false });
    try {
      const res = await say(app, token, randomUUID(), "Hi");
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json()).toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE" });
      expect(seen).toHaveLength(2); // one retry
    } finally {
      await app.close();
    }
  });
});

describe("onboarding REPLAY for a new account (not the seeded Dana)", () => {
  it("serves the onboarding recording for any user and any first message", async () => {
    process.env.AGENT_MODE = "REPLAY";
    const { userId } = await createUserWithPasskey();
    const token = await mintAccessTokenForTests(userId);
    const app = await buildServer({ logger: false });
    try {
      const conversationId = randomUUID();
      const replies = [];
      for (const text of ["Hello!", "I'm Alex and I get money from home", "rent is due on the 1st", "ok, sounds good"]) {
        const res = await say(app, token, conversationId, text);
        expect(res.statusCode, res.body).toBe(200);
        replies.push(OnboardingMessageResponse.parse(res.json()));
      }
      expect(replies.map((r) => r.complete)).toEqual([false, false, false, true]);
      expect(seen).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
