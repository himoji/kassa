/*
 * Chat history: GET /agent/conversations (newest activity first, with message counts), PATCH (rename) and DELETE
 * (the conversation and everything stored for it). Another user's conversation answers 404 like a missing one.
 */
import { randomUUID } from "node:crypto";
import { ConversationsResponse } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { agentDocuments, agentMessages, conversations } from "../../src/db/schema.intel.ts";
import { placeholderMaps } from "../../src/db/schema.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey, offlineEnvironment } from "../helpers/fixtures.ts";
import { ensureIntelTables } from "../intel/intelTables.ts";

const t = useTestDb();
const app = useTestApp();

beforeEach(async () => {
  await t.reset();
  await ensureIntelTables(t.db());
  offlineEnvironment();
});

async function chat(userId: string, title: string, createdAt: string, messageTimes: string[]): Promise<string> {
  const id = randomUUID();
  await getDb().insert(conversations).values({ id, userId, channel: "agent", title, createdAt: new Date(createdAt) });
  if (messageTimes.length > 0) {
    await getDb()
      .insert(agentMessages)
      .values(messageTimes.map((at, seq) => ({ conversationId: id, userId, channel: "agent", seq, message: { role: "user" as const, content: `m${seq}` }, createdAt: new Date(at) })));
  }
  return id;
}

describe("chat history", () => {
  it("lists conversations by last activity with counts, renames and deletes them", async () => {
    const { userId } = await createUserWithPasskey();
    const h = await bearer(userId);
    const old = await chat(userId, "Tuition plan", "2026-10-01T10:00:00Z", ["2026-10-01T10:00:00Z", "2026-10-13T09:00:00Z"]);
    const recent = await chat(userId, "Budget for food", "2026-10-10T10:00:00Z", ["2026-10-10T10:00:00Z"]);
    const empty = await chat(userId, null as unknown as string, "2026-10-05T10:00:00Z", []);

    const list = ConversationsResponse.parse((await app().inject({ method: "GET", url: "/api/agent/conversations", headers: h })).json());
    expect(list.conversations.map((c) => c.id)).toEqual([old, recent, empty]);
    expect(list.conversations[0]).toMatchObject({ title: "Tuition plan", messageCount: 2, lastMessageAt: "2026-10-13T09:00:00.000Z" });
    expect(list.conversations[2]).toMatchObject({ messageCount: 0, lastMessageAt: "2026-10-05T10:00:00.000Z" });

    const renamed = await app().inject({ method: "PATCH", url: `/api/agent/conversations/${recent}`, headers: h, payload: { title: "  Groceries  " } });
    expect(renamed.statusCode, renamed.body).toBe(204);
    expect((await getDb().select().from(conversations).where(eq(conversations.id, recent)))[0]?.title).toBe("Groceries");
    expect((await app().inject({ method: "PATCH", url: `/api/agent/conversations/${recent}`, headers: h, payload: { title: " " } })).statusCode).toBe(400);

    await getDb().insert(placeholderMaps).values({ conversationId: old, userId, placeholder: "payee_1", kind: "PAYEE", realRef: randomUUID() });
    await getDb().insert(agentDocuments).values({ userId, conversationId: old, mediaType: "image/png", dataB64: "AAAA", createdAt: new Date() });
    const deleted = await app().inject({ method: "DELETE", url: `/api/agent/conversations/${old}`, headers: h });
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(await getDb().select().from(agentMessages).where(eq(agentMessages.conversationId, old))).toEqual([]);
    expect(await getDb().select().from(placeholderMaps).where(eq(placeholderMaps.conversationId, old))).toEqual([]);
    expect(await getDb().select().from(agentDocuments).where(eq(agentDocuments.conversationId, old))).toEqual([]);
    expect((await app().inject({ method: "GET", url: `/api/agent/conversations/${old}/messages`, headers: h })).statusCode).toBe(404);
    const after = ConversationsResponse.parse((await app().inject({ method: "GET", url: "/api/agent/conversations", headers: h })).json());
    expect(after.conversations.map((c) => c.id)).toEqual([recent, empty]);
  });

  it("another user cannot rename or delete a conversation", async () => {
    const a = await createUserWithPasskey();
    const b = await createUserWithPasskey();
    const id = await chat(a.userId, "Mine", "2026-10-10T10:00:00Z", ["2026-10-10T10:00:00Z"]);
    const hb = await bearer(b.userId);
    expect((await app().inject({ method: "PATCH", url: `/api/agent/conversations/${id}`, headers: hb, payload: { title: "Taken" } })).statusCode).toBe(404);
    expect((await app().inject({ method: "DELETE", url: `/api/agent/conversations/${id}`, headers: hb })).statusCode).toBe(404);
    expect((await getDb().select().from(conversations).where(eq(conversations.id, id)))[0]?.title).toBe("Mine");
    expect(await getDb().select().from(agentMessages).where(eq(agentMessages.conversationId, id))).toHaveLength(1);
  });
});
