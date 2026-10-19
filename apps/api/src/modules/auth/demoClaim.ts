import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { judgeCopyReference, judgeCopyStudentId, judgeCopySuffix } from "../../../../../fixtures/judge-copy.ts";
import { getDb } from "../../db/client.ts";
import { demoState, users } from "../../db/schema.ts";
import { HttpProblem } from "../../http/problem.ts";
import { mockWorld } from "../rails/http.ts";
import { bankMode } from "../rails/bankApi.ts";
import { insertSeedUserCopy, loadSeedData, seedUserCopy, type SeedData, type SeedPersonaData, type SeedUserData } from "../demo/seed.ts";
import { ensureWalletProfile } from "../wallet/service.ts";

/**
 * The seeded demo account a `demoClaim` names: `true` = the seeded hero, a string = that seeded persona key (D-CN3,
 * seed `personas`). Used by the demo-claim registration and by the dev sign-in's demo mode.
 */
export async function demoClaimUserId(claim: true | string): Promise<string> {
  const db = getDb();
  const ds = (await db.select().from(demoState).where(eq(demoState.id, 1)))[0];
  if (!ds?.demoUserId) throw new HttpProblem(409, "DEMO_NOT_SEEDED", "Run the seed first");
  if (claim === true) return ds.demoUserId;
  const persona = (await loadSeedData()).personas?.find((p) => p.persona === claim);
  if (!persona) throw new HttpProblem(404, "DEMO_PERSONA_UNKNOWN", `No seeded demo persona "${claim}"`);
  const seeded = (await db.select({ id: users.id }).from(users).where(eq(users.id, persona.user.id)))[0];
  if (!seeded) throw new HttpProblem(409, "DEMO_NOT_SEEDED", "Seed with personas first (bun run seed, sim up, or demo reset)");
  return persona.user.id;
}

type SeedAccount = SeedUserData & Pick<SeedPersonaData, "accountType" | "business">;

/** The seed data of the account a `demoClaim` names (the hero is the seed's top-level user). */
function claimedSeed(seed: SeedData, claim: true | string): SeedAccount {
  if (claim === true) {
    const { seedNow: _n, homeCurrency: _h, personas: _p, ...hero } = seed;
    return hero;
  }
  const persona = seed.personas?.find((p) => p.persona === claim);
  if (!persona) throw new HttpProblem(404, "DEMO_PERSONA_UNKNOWN", `No seeded demo persona "${claim}"`);
  return persona;
}

/**
 * Judge build (auth/dev.ts `judgeModeActive`): a private copy of the seeded account a `demoClaim` names, under a new
 * user id, so no two sign-ins share payments, chats, caps or bills. Same rows as the seed (demo/seed.ts
 * `seedUserCopy`), plus a capped wallet of its own in the mock bank funded with the seeded balances. Returns the new
 * user id and the copy (its seeded mandates still have to be signed, which the caller does with the user's passkey).
 * Like `demoClaimUserId`, it needs the seed to have run (the demo clock is set by it).
 */
export async function judgeDemoCopy(claim: true | string): Promise<{ userId: string; copy: SeedAccount }> {
  const db = getDb();
  const ds = (await db.select({ demoUserId: demoState.demoUserId }).from(demoState).where(eq(demoState.id, 1)))[0];
  if (!ds?.demoUserId) throw new HttpProblem(409, "DEMO_NOT_SEEDED", "Run the seed first");
  const seed = await loadSeedData();
  const userId = randomUUID();
  const copy = ownSchoolIdentifiers(seedUserCopy(claimedSeed(seed, claim), userId), userId);
  await insertSeedUserCopy(db, seed.seedNow, copy, claim === true ? "hero" : claim);
  await fundWallet(userId, copy.balances ?? []);
  return { userId, copy };
}

/**
 * The copy's own student ID at its school and its own tuition invoice reference (fixtures/judge-copy.ts): the school
 * portal keeps an invoice's state under them, so with the seeded ones one reviewer's tuition payment would show as
 * paid in every other copy. The other seeded identifiers (rent and insurance references, customer numbers, accounts)
 * have no state in the mock world and stay as seeded.
 */
export function ownSchoolIdentifiers<T extends SeedAccount>(copy: T, userId: string): T {
  const suffix = judgeCopySuffix(userId);
  const tuition = new Set<string>();
  for (const p of copy.payees) {
    if (p.details?.category !== "TUITION" || !p.details.studentId) continue;
    p.details = { ...p.details, studentId: judgeCopyStudentId(p.details.studentId, userId) };
    tuition.add(p.id);
  }
  for (const o of copy.obligations) {
    if (tuition.has(o.payeeId) && o.reference) o.reference = judgeCopyReference(o.reference, suffix);
  }
  return copy;
}

/**
 * Open the copy's wallet and credit the seeded balances (mock bank only; the Wise sandbox has one shared profile).
 * Best effort, like the demo reset's mock-world call: the mock world is in memory and may be down, and the account
 * works without a wallet (payments then fail at the rail, as for any user whose bank is unreachable). The top-up
 * references are per user and currency, so a retry never credits twice.
 */
async function fundWallet(userId: string, balances: readonly { currency: string; amountMinor: number }[]): Promise<void> {
  if (bankMode() !== "mock") return;
  try {
    const profileId = await ensureWalletProfile(userId);
    for (const b of balances) {
      if (b.amountMinor <= 0) continue;
      await mockWorld("POST", "/bank/top-ups", { profileId, currency: b.currency, amountMinor: b.amountMinor, reference: `seed:${userId}:${b.currency}` });
    }
  } catch (err) {
    console.warn(`[demo] wallet for ${userId} not funded: ${(err as Error).message}`);
  }
}
