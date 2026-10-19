/*
 * POST /agent/transcribe: the chat's mic button. A session (the app, the web app, a KassaLite device) sends a
 * recording, VOICE_MODEL turns it into text, and only {text} comes back: no turn runs and nothing is stored. AI
 * consent applies as on every agent route; a missing key or a refused format is a readable problem, not a 500.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { conversations } from "../../src/db/schema.intel.ts";
import { MAX_VOICE_BYTES } from "../../src/modules/ai/voice.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey, offlineEnvironment } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

const transcribe = async (userId: string | null, payload: Record<string, unknown>) =>
  app().inject({ method: "POST", url: "/api/agent/transcribe", headers: userId ? await bearer(userId) : {}, payload });

/** OpenRouter stand-in: records what was sent and answers with `content` (or an error status). */
function stubOpenRouter(answer: { status?: number; content?: string } = {}) {
  const sent: { body: Record<string, unknown> }[] = [];
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).startsWith("https://openrouter.ai/")) return real(url, init);
    sent.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const status = answer.status ?? 200;
    return new Response(JSON.stringify(status === 200 ? { choices: [{ message: { content: answer.content ?? "" } }] } : { error: { message: "bad audio" } }), { status });
  }) as typeof fetch);
  return sent;
}

describe("POST /agent/transcribe", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("needs a session", async () => {
    expect((await transcribe(null, { audioBase64: "AAAA", format: "wav" })).statusCode).toBe(401);
  });

  it("returns the transcript only; no conversation is created", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const sent = stubOpenRouter({ content: "“How much did I spend on coffee this week?”" });
    const { userId } = await createUserWithPasskey();
    const res = await transcribe(userId, { audioBase64: "UklGRiQAAABXQVZF", format: "wav" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: "How much did I spend on coffee this week?" });
    const parts = (sent[0]!.body.messages as { content: { type: string; input_audio?: unknown }[] }[])[0]!.content;
    expect(parts.find((p) => p.type === "input_audio")!.input_audio).toEqual({ data: "UklGRiQAAABXQVZF", format: "wav" });
    expect(await getDb().select().from(conversations)).toHaveLength(0);
  });

  it("without AI consent nothing reaches the model", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const sent = stubOpenRouter({ content: "hi" });
    const { userId } = await createUserWithPasskey({ aiConsent: false });
    const res = await transcribe(userId, { audioBase64: "AAAA", format: "m4a" });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("AI_CONSENT_REQUIRED");
    expect(sent).toHaveLength(0);
  });

  it("no voice key → 503 with the configuration code", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("LOCAL_API_KEY", "");
    const { userId } = await createUserWithPasskey();
    const res = await transcribe(userId, { audioBase64: "AAAA", format: "m4a" });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("AI_PROVIDER_KEY_MISSING");
  });

  it("a recording the model refuses → 422 VOICE_UNREADABLE; a provider failure → 502", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { userId } = await createUserWithPasskey();
    stubOpenRouter({ status: 400 });
    expect((await transcribe(userId, { audioBase64: "AAAA", format: "ogg" })).json().code).toBe("VOICE_UNREADABLE");
    vi.unstubAllGlobals();
    stubOpenRouter({ status: 500 });
    const res = await transcribe(userId, { audioBase64: "AAAA", format: "ogg" });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe("VOICE_UNAVAILABLE");
  });

  it("refuses formats the model does not take, non-base64 bodies and recordings over MAX_VOICE_BYTES", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const sent = stubOpenRouter({ content: "x" });
    const { userId } = await createUserWithPasskey();
    expect((await transcribe(userId, { audioBase64: "AAAA", format: "webm" })).statusCode).toBe(400);
    expect((await transcribe(userId, { audioBase64: "not base64!", format: "wav" })).json().code).toBe("VOICE_AUDIO_INVALID");
    const tooBig = "A".repeat(Math.ceil(((MAX_VOICE_BYTES + 3) * 4) / 3));
    const res = await transcribe(userId, { audioBase64: tooBig, format: "wav" });
    expect(res.statusCode).toBe(413);
    expect(sent).toHaveLength(0);
  });
});
