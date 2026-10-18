/*
 * Judge build (JUDGE_MODE + DEMO_ENABLED): every dev sign-in gets its own account. `demoClaim` copies the seeded persona
 * under a new user id (auth/demoClaim.ts judgeDemoCopy, demo/seed.ts seedUserCopy) and signs its onboarding and seeded
 * mandates with the copy's dev passkey through the normal routes; nothing is shared between sign-ins. Outside the judge
 * build `demoClaim` still enters the single seeded persona.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { mandates, merchants, obligations, payees, profiles, transactions, users, webauthnCredentialsRules } from "../../src/db/schema.ts";
import { resetEnvCache, setEnvForTests } from "../../src/env.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase, type SeedData } from "../../src/modules/demo/seed.ts";
import { ledger } from "../../src/modules/ledger/index.ts";
import { mockWorld } from "../../src/modules/rails/http.ts";
import { proposeOrder } from "../../src/modules/rules/index.ts";
import { useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { offlineEnvironment } from "../helpers/fixtures.ts";
import { startMockWorld, type TestMockWorld } from "../helpers/mockWorld.ts";
import { ensureIntelTables } from "../intel/intelTables.ts";

const t = useTestDb();
const app = useTestApp();
let mw: TestMockWorld;
let seed: SeedData;

beforeAll(async () => {
  await ensureIntelTables(t.db());
  mw = await startMockWorld();
  seed = await loadSeedData();
});

afterAll(async () => {
  await mw.close();
});

beforeEach(async () => {
  await seedDatabase(getDb(), seed, { reset: true, personas: true });
});

afterEach(() => {
  resetEnvCache();
  clock.setOffsetInMemoryForTests(0);
});

const judgeEnv = () => setEnvForTests({ DEMO_ENABLED: "true", JUDGE_MODE: "true" });

async function login(payload: Record<string, unknown>) {
  const res = await app().inject({ method: "POST", url: "/api/auth/dev/login", payload: { client: "native", ...payload } });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { user: { id: string; displayName: string }; onboarded: boolean; tokens: { accessToken: string } };
  return { ...body, h: { authorization: `Bearer ${body.tokens.accessToken}` } };
}

describe("judge build: a private copy of the persona per dev sign-in", () => {
  it("two sign-ins as Dana get different users, each with its own onboarded copy of the seed", async () => {
    judgeEnv();
    const started = Date.now();
    const a = await login({ demoClaim: true });
    const elapsedMs = Date.now() - started;
    const b = await login({ demoClaim: true });
    expect(elapsedMs).toBeLessThan(5_000);

    expect(a.user.id).not.toBe(b.user.id);
    for (const s of [a, b]) {
      expect(s.user.id).not.toBe(seed.user.id);
      expect(s.user.displayName).toBe(seed.user.displayName);
      expect(s.onboarded).toBe(true);
      const me = await app().inject({ method: "GET", url: "/api/me", headers: s.h });
      expect(me.statusCode, me.body).toBe(200);
      expect(me.json().onboarded).toBe(true);
      // Backup codes made with the copy's dev passkey: the app opens on the home screen, not on the backup-codes step.
      const codes = await app().inject({ method: "GET", url: "/api/auth/recovery-codes", headers: s.h });
      expect(codes.statusCode, codes.body).toBe(200);
      expect(codes.json().remaining).toBe(10);
    }

    const db = getDb();
    const payeesOf = (userId: string) => db.select().from(payees).where(eq(payees.userId, userId));
    const [pa, pb] = [await payeesOf(a.user.id), await payeesOf(b.user.id)];
    // The same payees (names, statuses), under ids of their own.
    expect(pa.map((p) => `${p.name}:${p.status}`).sort()).toEqual(seed.payees.map((p) => `${p.name}:${p.status}`).sort());
    expect(pb.map((p) => `${p.name}:${p.status}`).sort()).toEqual(pa.map((p) => `${p.name}:${p.status}`).sort());
    const ids = new Set([...pa, ...pb].map((p) => p.id));
    expect(ids.size).toBe(pa.length + pb.length);
    for (const p of seed.payees) expect(ids.has(p.id)).toBe(false);
    expect(pa.some((p) => p.kind === "LANDLORD" && p.status === "VERIFIED")).toBe(true);

    for (const s of [a, b]) {
      const own = new Set((await payeesOf(s.user.id)).map((p) => p.id));
      const bills = await db.select().from(obligations).where(eq(obligations.userId, s.user.id));
      expect(bills).toHaveLength(seed.obligations.length);
      for (const o of bills) expect(own.has(o.payeeId)).toBe(true);
      const txns = await db.select().from(transactions).where(eq(transactions.userId, s.user.id));
      expect(txns).toHaveLength(seed.transactions.length);
      for (const x of txns) if (x.dedupeKey) expect(x.dedupeKey.startsWith(`${s.user.id}|`)).toBe(true);
      // The seeded rent mandate, signed by this user's own passkey for this user's own landlord.
      const ms = await db.select().from(mandates).where(eq(mandates.userId, s.user.id));
      expect(ms).toHaveLength(seed.mandates?.length ?? 0);
      for (const m of ms) for (const id of m.payeeIds) expect(own.has(id)).toBe(true);
      // In effect at once on the judge build (the shared clock cannot be moved there); payee cooling is untouched.
      for (const m of ms) expect(m.status).toBe("ACTIVE");
      const prof = (await db.select().from(profiles).where(eq(profiles.userId, s.user.id)))[0]!;
      expect(prof.baseRulesSignedAt).not.toBeNull();
      expect(prof.bankProfileId).not.toBe(seed.mockBankProfileId);
      expect((await db.select().from(users).where(eq(users.id, s.user.id)))[0]!.aiConsentAt).not.toBeNull();
    }

    // Wallets of their own in the mock bank, funded with the seeded balances.
    const profileOf = async (userId: string) => (await db.select({ id: profiles.bankProfileId }).from(profiles).where(eq(profiles.userId, userId)))[0]!.id!;
    const [wa, wb] = [await profileOf(a.user.id), await profileOf(b.user.id)];
    expect(wa).not.toBe(wb);
    const balances = async (p: number) => (await mockWorld<{ currency: string }[]>("GET", `/v4/profiles/${p}/balances`)).map((x) => x.currency).sort();
    expect(await balances(wa)).toEqual([...(seed.balances ?? [])].filter((x) => x.amountMinor > 0).map((x) => x.currency).sort());

    // The seeded persona itself is untouched: no passkey, not onboarded.
    expect(await db.select().from(webauthnCredentialsRules).where(eq(webauthnCredentialsRules.userId, seed.user.id))).toHaveLength(0);
    expect((await db.select().from(profiles).where(eq(profiles.userId, seed.user.id)))[0]!.baseRulesSignedAt).toBeNull();
    expect((await ledger.verify()).ok).toBe(true);
  });

  it("one copy paying its rent does not affect the other's", async () => {
    judgeEnv();
    offlineEnvironment();
    const a = await login({ demoClaim: true });
    const b = await login({ demoClaim: true });
    const db = getDb();
    const rentOf = async (userId: string) =>
      (await db.select({ o: obligations }).from(obligations).innerJoin(payees, eq(payees.id, obligations.payeeId)).where(and(eq(obligations.userId, userId), eq(payees.kind, "LANDLORD"))))[0]!.o;
    const propose = async (userId: string) => {
      const o = await rentOf(userId);
      return proposeOrder({ userId, createdBy: "AGENT", payeeId: o.payeeId, amountMinor: o.amountMinor, currency: o.currency, purpose: "Rent", category: "rent", obligationId: o.id });
    };

    // The copy's rent mandate is in effect: the agent pays the verified landlord on its own (T1).
    const first = await propose(a.user.id);
    expect(first.decision, JSON.stringify(first)).toBe("AUTO");
    expect(first.reasonCodes).toContain("MANDATE_MATCH");
    // The check the judge ran into still holds within one account...
    const again = await propose(a.user.id);
    expect(again.decision).toBe("REFUSE");
    expect(again.reasonCodes).toContain("DUPLICATE_OBLIGATION_PAYMENT");
    // ...but the other copy's rent is its own.
    const other = await propose(b.user.id);
    expect(other.decision, JSON.stringify(other)).toBe("AUTO");
    expect(other.reasonCodes).not.toContain("DUPLICATE_OBLIGATION_PAYMENT");
  });

  it("copies the other personas too (a business persona gets a merchant of its own)", async () => {
    judgeEnv();
    for (const persona of seed.personas ?? []) {
      const s = await login({ demoClaim: persona.persona });
      expect(s.user.id).not.toBe(persona.user.id);
      expect(s.onboarded, persona.persona).toBe(true);
      expect(await getDb().select().from(payees).where(eq(payees.userId, s.user.id))).toHaveLength(persona.payees.length);
      if (persona.business) {
        const m = (await getDb().select().from(merchants).where(eq(merchants.ownerUserId, s.user.id)))[0]!;
        expect(m.id).not.toBe(persona.business.merchant.id);
        expect(m.slug).not.toBe(persona.business.merchant.slug);
        expect((await getDb().select().from(merchants).where(eq(merchants.id, persona.business.merchant.id)))[0]!.ownerUserId).toBe(persona.user.id);
      }
    }
    expect((await app().inject({ method: "POST", url: "/api/auth/dev/login", payload: { client: "native", demoClaim: "nobody" } })).statusCode).toBe(404);
  });

  it("`fresh` and the plain sign-in make a new, not onboarded user every time", async () => {
    judgeEnv();
    const ids = new Set<string>();
    for (const payload of [{ fresh: true }, { fresh: true }, {}, {}]) {
      const s = await login(payload);
      expect(s.onboarded).toBe(false);
      ids.add(s.user.id);
    }
    expect(ids.size).toBe(4);
  });
});

describe("outside the judge build", () => {
  it("demoClaim still enters the single seeded persona", async () => {
    setEnvForTests({ DEMO_ENABLED: "true", DEV_LOGIN: "true", RP_ID: "localhost" });
    const a = await login({ demoClaim: true });
    const b = await login({ demoClaim: true });
    expect(a.user.id).toBe(seed.user.id);
    expect(b.user.id).toBe(seed.user.id);
    expect(a.onboarded).toBe(false);
    const liWei = seed.personas!.find((p) => p.persona === "li-wei")!;
    expect((await login({ demoClaim: "li-wei" })).user.id).toBe(liWei.user.id);
    const usersBefore = (await getDb().select({ id: users.id }).from(users)).length;
    await login({ demoClaim: true });
    expect((await getDb().select({ id: users.id }).from(users)).length).toBe(usersBefore);
  });
});
