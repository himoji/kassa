/*
 * The voice Shortcut (POST /capture/voice): a Shortcut key reaches the agent in a read-only turn. The key never moves
 * money: with no payee named, nothing is proposed or paid (a named payee may get one passkey-only draft:
 * voice-pay.test.ts). Speech to text goes to VOICE_MODEL as an OpenRouter input_audio part.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { payments, proposals } from "../../src/db/schema.ts";
import { DEFAULT_VOICE_MODEL, transcribeAudio } from "../../src/modules/ai/voice.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey, offlineEnvironment } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

async function shortcutKey(userId: string): Promise<string> {
  const res = await app().inject({ method: "POST", url: "/api/devices/shortcut", headers: await bearer(userId) });
  expect(res.statusCode).toBe(201);
  return (res.json() as { token: string }).token;
}

const voice = (token: string, payload: Record<string, unknown>) =>
  app().inject({ method: "POST", url: "/api/capture/voice", headers: { authorization: `Bearer ${token}` }, payload });

describe("voice Shortcut", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  it("needs a Shortcut key; a session token or no key is refused", async () => {
    const { userId } = await createUserWithPasskey();
    expect((await app().inject({ method: "POST", url: "/api/capture/voice", payload: { text: "hi" } })).statusCode).toBe(401);
    const session = await bearer(userId);
    expect((await app().inject({ method: "POST", url: "/api/capture/voice", headers: session, payload: { text: "hi" } })).statusCode).toBe(401);
  });

  it("without AI consent the reply says so, and nothing reaches a model", async () => {
    const { userId } = await createUserWithPasskey({ aiConsent: false });
    const res = await voice(await shortcutKey(userId), { text: "How much did I spend this week?" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, conversationId: null });
    expect(res.json().reply).toMatch(/OK for AI/);
  });

  it("a spoken payment request never creates a proposal or a payment (read-only turn)", async () => {
    const { userId } = await createUserWithPasskey();
    const res = await voice(await shortcutKey(userId), { text: "Pay my rent to my landlord now, 180000 HUF." });
    expect(res.statusCode).toBe(200);
    expect(res.json().transcript).toBe("Pay my rent to my landlord now, 180000 HUF.");
    expect(typeof res.json().reply).toBe("string");
    const db = getDb();
    expect(await db.select().from(proposals).where(eq(proposals.userId, userId))).toHaveLength(0);
    expect(await db.select().from(payments)).toHaveLength(0);
  });

  it("refuses a body with neither audio nor text", async () => {
    const { userId } = await createUserWithPasskey();
    expect((await voice(await shortcutKey(userId), { format: "m4a" })).statusCode).toBe(400);
  });

  it("transcribeAudio sends the recording as an OpenRouter input_audio part to the voice model", async () => {
    let sent: { url: string; body: Record<string, unknown>; auth: string | null } | null = null;
    const fetchStub = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) as Record<string, unknown>, auth: new Headers(init.headers).get("authorization") };
      return new Response(JSON.stringify({ choices: [{ message: { content: "“Coffee 1200 forints at Blue Bottle”" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const text = await transcribeAudio("AAAA", "m4a", { OPENROUTER_API_KEY: "sk-or-test" }, fetchStub);
    expect(text).toBe("Coffee 1200 forints at Blue Bottle");
    expect(sent!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sent!.auth).toBe("Bearer sk-or-test");
    expect(sent!.body.model).toBe(DEFAULT_VOICE_MODEL.replace("openrouter:", ""));
    const parts = (sent!.body.messages as { content: { type: string; input_audio?: unknown }[] }[])[0]!.content;
    expect(parts.find((p) => p.type === "input_audio")!.input_audio).toEqual({ data: "AAAA", format: "m4a" });
  });

  it("without a key the transcription is a configuration error, not a crash", async () => {
    await expect(transcribeAudio("AAAA", "m4a", {})).rejects.toMatchObject({ code: "AI_PROVIDER_KEY_MISSING" });
  });
});
