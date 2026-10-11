/*
 * Test fixtures: users with real (software) passkeys in BOTH credential tables, payees, signed base rules,
 * signed + effective mandates, stub rails. Everything goes through the same DB the modules use.
 */
import { jcsHash, mandateHash, normalizeMandateCore, type BaseRulesCore, type MandateCore, type Rail as RailId } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { getDb } from "../../src/db/client.ts";
import { mandates, payees, profiles, users, webauthnCredentialsPayments, webauthnCredentialsRules } from "../../src/db/schema.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { setBalanceProviderForTests } from "../../src/modules/rules/facts.ts";
import { useFallbackFxForTests } from "../../src/modules/money/fx.ts";
import { wireExecutor } from "../../src/modules/orders/wiring.ts";
import { accountHash, encryptAccount, normalizeAccount } from "../../src/modules/payees/crypto.ts";
import { setRailOverridesForTests, type Rail } from "../../src/modules/rails/index.ts";
import { DEFAULT_CAPS, createUser } from "../../src/modules/users/service.ts";
import { SoftAuthenticator } from "./webauthn.ts";

export const IBAN_LANDLORD = "HU75109183242065038100000003";
export const IBAN_UNIVERSITY = "HU83118009905400221700000005";
export const IBAN_OTHER = "HU03162002169011744200000000";

/** Deterministic offline environment: fallback FX, no wallet balances, stub rails, executor wired. */
export function offlineEnvironment(): { railCalls: { rail: RailId; amountMinor: number }[] } {
  const railCalls: { rail: RailId; amountMinor: number }[] = [];
  useFallbackFxForTests(true);
  setBalanceProviderForTests(async () => null);
  const stub = (id: RailId, status: "PROCESSING" | "SENT" = "PROCESSING"): Rail => ({
    id,
    async execute(order) {
      railCalls.push({ rail: id, amountMinor: order.amountMinor });
      return { status, railRef: `stub_${randomUUID()}`, details: { stub: true } };
    },
  });
  setRailOverridesForTests({ BANK_TRANSFER: stub("BANK_TRANSFER"), HANDOFF: stub("HANDOFF") });
  wireExecutor();
  return { railCalls };
}

export async function createUserWithPasskey(
  opts: { preset?: "ASK_ME" | "SMART" | "AUTOPILOT"; moneyMode?: "PAY_IN_PLACE" | "CAPPED_WALLET" | "HANDOFF" | null; region?: "EU" | "CN"; counter?: number } = {},
) {
  const db = getDb();
  const id = randomUUID();
  const auth = new SoftAuthenticator({ counter: opts.counter ?? 0 });
  await db.transaction(async (tx) => {
    await createUser(tx, { id, displayName: "Test User" });
    await tx
      .update(users)
      .set({
        preset: opts.preset ?? "SMART",
        region: opts.region ?? "EU",
        overrides: { agentAutonomy: null, paymentPolicy: null, moneyMode: opts.moneyMode ?? null },
      })
      .where(eq(users.id, id));
    const row = { userId: id, credentialId: auth.id, publicKey: auth.publicKeyB64u(), counter: auth.counter, transports: ["internal"] };
    await tx.insert(webauthnCredentialsRules).values(row);
    await tx.insert(webauthnCredentialsPayments).values(row);
  });
  return { userId: id, auth };
}

export async function addPayee(
  userId: string,
  p: { name: string; kind?: "LANDLORD" | "UNIVERSITY" | "MERCHANT" | "PERSON" | "SUPPLIER"; account?: string; currency?: string; status?: "VERIFIED" | "COOLING" | "BLOCKED"; coolingUntil?: Date | null },
) {
  const account = p.account ?? IBAN_LANDLORD;
  const rows = await getDb()
    .insert(payees)
    .values({
      userId,
      name: p.name,
      kind: p.kind ?? "LANDLORD",
      accountEnc: encryptAccount(userId, normalizeAccount(account)),
      accountHash: accountHash(account),
      country: "HU",
      currency: p.currency ?? "HUF",
      status: p.status ?? "VERIFIED",
      verifiedAt: (p.status ?? "VERIFIED") === "VERIFIED" ? clock.now() : null,
      coolingUntil: p.coolingUntil ?? null,
    })
    .returning();
  return rows[0]!;
}

/** Sign base rules (onboarding) with the soft passkey, directly in the profile. */
export async function signBaseRules(userId: string, auth: SoftAuthenticator, homeCurrency = "KZT") {
  const db = getDb();
  const u = (await db.select().from(users).where(eq(users.id, userId)))[0]!;
  const p = (await db.select().from(profiles).where(eq(profiles.userId, userId)))[0]!;
  const caps = p.caps ?? DEFAULT_CAPS;
  const core: BaseRulesCore = {
    v: 1,
    userId,
    settings: { preset: u.preset, region: u.region, homeCurrency, notificationMode: p.notificationMode, overrides: u.overrides },
    caps: { currency: homeCurrency, ...caps },
  };
  const hash = jcsHash(core);
  await db
    .update(profiles)
    .set({ baseRules: core as never, baseRulesHash: hash, baseRulesAssertion: auth.assert(hash) as never, baseRulesSignedAt: clock.now() })
    .where(eq(profiles.userId, userId));
}

/** A signed mandate, already ACTIVE and effective (bypasses the 24 h wait for unit tests). */
export async function addActiveMandate(
  userId: string,
  auth: SoftAuthenticator,
  m: { payeeIds: string[]; categories: string[]; currency: string; maxPerPaymentMinor: number; maxPerPeriodMinor: number; period?: "WEEK" | "MONTH" },
) {
  const now = clock.now();
  const core: MandateCore = normalizeMandateCore({
    v: 1,
    mandateId: randomUUID(),
    userId,
    payeeIds: m.payeeIds,
    categories: m.categories,
    currency: m.currency,
    maxPerPaymentMinor: m.maxPerPaymentMinor,
    maxPerPeriodMinor: m.maxPerPeriodMinor,
    period: m.period ?? "MONTH",
    validFrom: new Date(now.getTime() - 86_400_000).toISOString(),
    validUntil: null,
  });
  const hash = mandateHash(core);
  await getDb()
    .insert(mandates)
    .values({
      id: core.mandateId,
      userId,
      payeeIds: core.payeeIds,
      categories: core.categories,
      currency: core.currency,
      maxPerPaymentMinor: core.maxPerPaymentMinor,
      maxPerPeriodMinor: core.maxPerPeriodMinor,
      period: core.period,
      validFrom: new Date(core.validFrom),
      validUntil: null,
      mandateHash: hash,
      userAssertion: auth.assert(hash) as never,
      status: "ACTIVE",
      effectiveAt: new Date(now.getTime() - 1000),
    });
  return core;
}

export function resetOverrides(): void {
  setRailOverridesForTests({});
  setBalanceProviderForTests(null);
}
