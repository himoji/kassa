/*
 * I8 for freeze/unfreeze (docs/architecture/decisions.md 2026-10-11): freeze is instant; unfreeze is a loosening —
 * fresh passkey assertion over a server-built single-use challenge, effective 24 h later on the demo clock,
 * recorded in rule_changes. Plus the retention purge job (GDPR Art. 5(1)(e)).
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { ledgerEntries, notifications, placeholderMaps, ruleChanges, transactions, users } from "../../src/db/schema.ts";
import { agentDocuments, agentMessages } from "../../src/db/schema.intel.ts";
import { resetEnvCache, setEnvForTests } from "../../src/env.ts";
import { addMs, clock, DAY_MS } from "../../src/modules/clock/index.ts";
import { purgeExpired, purgeIfDue, resetPurgeScheduleForTests } from "../../src/modules/privacy/service.ts";
import { proposeOrder } from "../../src/modules/rules/index.ts";
import { tick } from "../../src/modules/scheduler/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { addPayee, createUserWithPasskey, offlineEnvironment } from "../helpers/fixtures.ts";
import type { SoftAuthenticator } from "../helpers/webauthn.ts";
import { ensureIntelTables } from "../intel/intelTables.ts";

const t = useTestDb();
const app = useTestApp();

async function frozenUser() {
  const u = await createUserWithPasskey();
  const h = await bearer(u.userId);
  expect((await app().inject({ method: "POST", url: "/api/freeze", headers: h })).statusCode).toBe(200);
  return { ...u, h };
}

async function signUnfreeze(h: Record<string, string>, auth: SoftAuthenticator) {
  const first = await app().inject({ method: "POST", url: "/api/unfreeze", headers: h, payload: {} });
  expect(first.statusCode, first.body).toBe(428);
  expect(first.json()).toMatchObject({ code: "PASSKEY_REQUIRED", reasonCodes: ["PASSKEY_REQUIRED", "UNFREEZE_PENDING"] });
  const d = first.json().details as { challengeId: string; webauthnOptions: { challenge: string } };
  return { d, res: await app().inject({ method: "POST", url: "/api/unfreeze", headers: h, payload: { challengeId: d.challengeId, assertion: auth.assert(d.webauthnOptions.challenge) } }) };
}

const isFrozen = async (userId: string) => (await getDb().select().from(users).where(eq(users.id, userId)))[0]!.frozenAt !== null;

describe("unfreeze is a loosening (I8)", () => {
  beforeEach(async () => {
    await t.reset();
    await ensureIntelTables(t.db());
    offlineEnvironment();
  });

  it("passkey + 24 h: still frozen before, unfrozen after; payments refused meanwhile", async () => {
    const { userId, auth, h } = await frozenUser();
    const { res } = await signUnfreeze(h, auth);
    expect(res.statusCode, res.body).toBe(200);
    const effectiveAt = Date.parse(res.json().effectiveAt);
    expect(effectiveAt - clock.nowMs()).toBeGreaterThanOrEqual(DAY_MS - 1000);
    const rc = (await getDb().select().from(ruleChanges).where(and(eq(ruleChanges.userId, userId), eq(ruleChanges.kind, "UNFREEZE"))))[0]!;
    expect(rc).toMatchObject({ direction: "LOOSEN", appliedAt: null });
    expect(rc.assertion).not.toBeNull();

    const payee = await addPayee(userId, { name: "Landlord" });
    expect((await proposeOrder({ userId, createdBy: "USER", payeeId: payee.id, amountMinor: 1000, currency: "HUF", purpose: "x" })).reasonCodes).toContain("REFUSE_FROZEN");
    // A second request while one is pending.
    const again = await app().inject({ method: "POST", url: "/api/unfreeze", headers: h, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("UNFREEZE_PENDING");

    await clock.advanceHours(23);
    await tick();
    expect(await isFrozen(userId)).toBe(true);
    await clock.advanceHours(1.1);
    await tick();
    expect(await isFrozen(userId)).toBe(false);
    const types = (await getDb().select({ type: ledgerEntries.type }).from(ledgerEntries)).map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(["ACCOUNT_FROZEN", "UNFREEZE_REQUESTED", "ACCOUNT_UNFROZEN"]));
  });

  it("freezing again cancels a pending unfreeze (tightening wins)", async () => {
    const { userId, auth, h } = await frozenUser();
    expect((await signUnfreeze(h, auth)).res.statusCode).toBe(200);
    expect((await app().inject({ method: "POST", url: "/api/freeze", headers: h })).statusCode).toBe(200);
    await clock.advanceHours(25);
    await tick();
    expect(await isFrozen(userId)).toBe(true);
    const rc = (await getDb().select().from(ruleChanges).where(eq(ruleChanges.userId, userId)))[0]!;
    expect(rc.canceledAt).not.toBeNull();
  });

  it("no assertion, a wrong assertion, another user's challenge, or a replayed assertion never unfreeze", async () => {
    const { userId, auth, h } = await frozenUser();
    const first = await app().inject({ method: "POST", url: "/api/unfreeze", headers: h, payload: {} });
    const d = first.json().details as { challengeId: string; webauthnOptions: { challenge: string } };
    // Signed over something else.
    const wrong = await app().inject({ method: "POST", url: "/api/unfreeze", headers: h, payload: { challengeId: d.challengeId, assertion: auth.assert("other") } });
    expect(wrong.statusCode).toBe(403);
    // The challenge was single use.
    const reuse = await app().inject({ method: "POST", url: "/api/unfreeze", headers: h, payload: { challengeId: d.challengeId, assertion: auth.assert(d.webauthnOptions.challenge) } });
    expect(reuse.statusCode).toBe(409);
    // A fresh challenge has a fresh nonce: the old assertion does not match it.
    const second = (await app().inject({ method: "POST", url: "/api/unfreeze", headers: h, payload: {} })).json().details as { challengeId: string; webauthnOptions: { challenge: string } };
    expect(second.webauthnOptions.challenge).not.toBe(d.webauthnOptions.challenge);
    const replay = await app().inject({ method: "POST", url: "/api/unfreeze", headers: h, payload: { challengeId: second.challengeId, assertion: auth.assert(d.webauthnOptions.challenge) } });
    expect(replay.statusCode).toBe(403);
    // Another user cannot use this user's challenge.
    const other = await createUserWithPasskey();
    await app().inject({ method: "POST", url: "/api/freeze", headers: await bearer(other.userId) });
    const third = (await app().inject({ method: "POST", url: "/api/unfreeze", headers: h, payload: {} })).json().details as { challengeId: string; webauthnOptions: { challenge: string } };
    const cross = await app().inject({ method: "POST", url: "/api/unfreeze", headers: await bearer(other.userId), payload: { challengeId: third.challengeId, assertion: other.auth.assert(third.webauthnOptions.challenge) } });
    expect(cross.statusCode).toBe(409);
    expect(await getDb().select().from(ruleChanges).where(eq(ruleChanges.userId, userId))).toHaveLength(0);
    await clock.advanceHours(48);
    await tick();
    expect(await isFrozen(userId)).toBe(true);
  });

  it("unfreeze of an account that is not frozen is refused", async () => {
    const { userId } = await createUserWithPasskey();
    const res = await app().inject({ method: "POST", url: "/api/unfreeze", headers: await bearer(userId), payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("NOT_FROZEN");
  });
});

describe("retention purge (RETENTION_DAYS_*)", () => {
  beforeEach(async () => {
    await t.reset();
    await ensureIntelTables(t.db());
  });

  it("deletes or minimises data past its retention period and keeps recent data", async () => {
    setEnvForTests({ RETENTION_DAYS_NOTIFICATIONS: "90", RETENTION_DAYS_PLACEHOLDER_MAPS: "30", RETENTION_DAYS_DOCUMENTS: "30", RETENTION_DAYS_CAPTURED_TEXT: "90" });
    try {
      const { userId } = await createUserWithPasskey();
      const db = getDb();
      const now = clock.now();
      const old = (days: number) => addMs(now, -days * DAY_MS);
      await db.insert(notifications).values([
        { userId, kind: "T", title: "old", body: "old", createdAt: old(91) },
        { userId, kind: "T", title: "new", body: "new", createdAt: old(10) },
      ]);
      const oldConv = randomUUID();
      const newConv = randomUUID();
      await db.insert(agentMessages).values([
        { conversationId: oldConv, userId, channel: "agent", seq: 0, message: { role: "user", content: "old" }, createdAt: old(40) },
        { conversationId: newConv, userId, channel: "agent", seq: 0, message: { role: "user", content: "new" }, createdAt: old(40) },
        { conversationId: newConv, userId, channel: "agent", seq: 1, message: { role: "user", content: "new" }, createdAt: old(1) },
      ]);
      await db.insert(placeholderMaps).values([
        { conversationId: oldConv, placeholder: "person_1", kind: "PERSON", realRef: "Old Name", createdAt: old(40) },
        { conversationId: newConv, placeholder: "person_1", kind: "PERSON", realRef: "Kept Name", createdAt: old(40) },
      ]);
      await db.insert(agentDocuments).values([
        { userId, mediaType: "text/plain", dataB64: "b2xk", createdAt: old(31) },
        { userId, mediaType: "text/plain", dataB64: "bmV3", createdAt: old(2) },
      ]);
      const base = { userId, source: "NOTIF_SIM" as const, occurredAt: old(100), merchantNorm: "market", amountMinor: 1, currency: "HUF", status: "SETTLED" as const };
      await db.insert(transactions).values([
        { ...base, merchantRaw: "MARKET HALL CARD *1234 raw", createdAt: old(100) },
        { ...base, merchantRaw: "MARKET HALL recent raw", createdAt: old(5) },
      ]);

      const counts = await purgeExpired(now);
      expect(counts).toEqual({ notifications: 1, conversations: 1, placeholderMaps: 1, documents: 1, capturedTexts: 1 });
      expect((await db.select().from(notifications)).map((n) => n.title)).toEqual(["new"]);
      expect(new Set((await db.select().from(agentMessages)).map((m) => m.conversationId))).toEqual(new Set([newConv]));
      expect((await db.select().from(placeholderMaps)).map((m) => m.realRef)).toEqual(["Kept Name"]);
      expect((await db.select().from(agentDocuments)).map((d) => d.dataB64)).toEqual(["bmV3"]);
      expect((await db.select().from(transactions)).map((x) => x.merchantRaw).sort()).toEqual(["MARKET HALL recent raw", "market"]);
      expect((await db.select().from(ledgerEntries).where(eq(ledgerEntries.type, "RETENTION_PURGED")))).toHaveLength(1);
      // Idempotent: nothing left to purge, nothing logged.
      expect(Object.values(await purgeExpired(now)).every((n) => n === 0)).toBe(true);
      expect((await db.select().from(ledgerEntries).where(eq(ledgerEntries.type, "RETENTION_PURGED")))).toHaveLength(1);
    } finally {
      resetEnvCache();
    }
  });

  it("runs from the scheduler on the demo clock, at most hourly; 0 days = keep", async () => {
    setEnvForTests({ RETENTION_DAYS_NOTIFICATIONS: "0" });
    try {
      const { userId } = await createUserWithPasskey();
      await getDb().insert(notifications).values({ userId, kind: "T", title: "ancient", body: "x", createdAt: addMs(clock.now(), -400 * DAY_MS) });
      resetPurgeScheduleForTests();
      expect(await purgeIfDue()).not.toBeNull();
      expect(await purgeIfDue()).toBeNull(); // within the hour
      expect(await getDb().select().from(notifications)).toHaveLength(1);
      setEnvForTests({ RETENTION_DAYS_NOTIFICATIONS: "90" });
      await clock.advanceHours(2);
      await tick();
      expect(await getDb().select().from(notifications)).toHaveLength(0);
    } finally {
      resetEnvCache();
    }
  });
});
