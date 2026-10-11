/*
 * Seed / reset (spec §18). Inserts fixtures/seed-data.ts (Track D) — or a minimal inline fallback when
 * the fixture is absent — into an EMPTY database (reset truncates every table first), then sets the demo
 * clock so Clock.now() == seed.seedNow (story time, see the fixture header).
 */
import { PRESET_DEFAULTS } from "@kassa/shared";
import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import {
  budgets,
  cardFeeProfiles,
  cards,
  demoState,
  obligations,
  payees,
  profiles,
  transactions,
  users,
} from "../../db/schema.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { accountHash, encryptAccount, normalizeAccount } from "../payees/crypto.ts";
import { DEFAULT_CAPS } from "../users/service.ts";

/** The subset of fixtures/seed-data.ts `seed` this loader uses. */
export type SeedData = {
  seedNow: string;
  homeCurrency: string;
  mockBankProfileId: number;
  user: { id: string; displayName: string; homeCurrency: string; region: "EU" | "CN"; preset: "ASK_ME" | "SMART" | "AUTOPILOT"; moneyMode: "PAY_IN_PLACE" | "CAPPED_WALLET" | "HANDOFF"; createdAt: string };
  profile: {
    incomes: { source: string; currency: string; amountMinor: number; cadence: "WEEKLY" | "MONTHLY" | "TERM" | "ONCE"; nextDate: string }[];
    notificationMode: "EACH" | "THRESHOLDS" | "DIGEST";
    reserveRules: { protectObligationCategories?: string[]; minBalances?: { currency: string; amountMinor: number }[] };
  };
  cards: { id: string; label: string; last4: string; billingCurrency: string; kind: "HOME_KZT" | "USD" | "LOCAL_HUF" | "MULTI" }[];
  cardFeeProfiles: { cardId: string; fromCurrency: string; toCurrency: string; medianMarkupBps: number; fixedFeeMinor: number; samples: number }[];
  payees: {
    id: string;
    name: string;
    kind: "LANDLORD" | "UNIVERSITY" | "INSURER" | "MERCHANT" | "SUPPLIER" | "PERSON" | "OWN_ACCOUNT";
    account: string;
    country: string;
    currency: string;
    status: "VERIFIED" | "COOLING" | "BLOCKED";
    verifiedAt: string | null;
    coolingUntil: string | null;
    replacesPayeeId: string | null;
  }[];
  obligations: { id: string; payeeId: string; amountMinor: number; currency: string; dueDate: string; recurrence: "MONTHLY" | "ONCE" | "TERM"; reference: string | null; category: string }[];
  budgets: { id: string; category: string; periodStart: string; periodEnd: string; limitHomeMinor: number }[];
  transactions: {
    id: string;
    source: "SHORTCUT" | "NOTIF_SIM" | "TEXT" | "VOICE" | "SCREENSHOT" | "SETTLEMENT" | "KASSA_PAYMENT";
    occurredAt: string;
    merchantRaw: string;
    merchantNorm: string;
    mcc: string | null;
    amountMinor: number;
    currency: string;
    cardId: string | null;
    homeAmountMinor: number;
    rateUsed: string;
    rateDate: string;
    settledAmountMinor: number | null;
    settledCurrency: string | null;
    feeHomeMinor: number | null;
    category: string;
    dedupeKey: string;
    mergedIntoId: string | null;
    status: "PENDING" | "SETTLED";
  }[];
};

/** Minimal fallback (used only when fixtures/seed-data.ts is missing). */
export const FALLBACK_SEED: SeedData = {
  seedNow: "2026-10-27T09:00:00.000Z",
  homeCurrency: "KZT",
  mockBankProfileId: 16_000_001,
  user: { id: "c83d27e3-4e03-570f-8fea-87db32399c12", displayName: "Dana", homeCurrency: "KZT", region: "EU", preset: "SMART", moneyMode: "CAPPED_WALLET", createdAt: "2026-09-20T08:00:00.000Z" },
  profile: { incomes: [], notificationMode: "EACH", reserveRules: { minBalances: [{ currency: "KZT", amountMinor: 5_000_000 }] } },
  cards: [],
  cardFeeProfiles: [],
  payees: [
    { id: "8244c30e-61a5-5c07-b556-a9b7706bd087", name: "Hillside Flats Kft.", kind: "LANDLORD", account: "HU75109183242065038100000003", country: "HU", currency: "HUF", status: "VERIFIED", verifiedAt: "2026-09-02T10:00:00.000Z", coolingUntil: null, replacesPayeeId: null },
  ],
  obligations: [
    { id: "c60680c9-e9b3-517f-8113-848cb50f5d10", payeeId: "8244c30e-61a5-5c07-b556-a9b7706bd087", amountMinor: 18_000_000, currency: "HUF", dueDate: "2026-11-01", recurrence: "MONTHLY", reference: null, category: "rent" },
  ],
  budgets: [],
  transactions: [],
};

export async function loadSeedData(): Promise<SeedData> {
  try {
    const path = new URL("../../../../../fixtures/seed-data.ts", import.meta.url).href;
    const mod = (await import(/* @vite-ignore */ path)) as { seed?: SeedData; default?: SeedData };
    const data = mod.seed ?? mod.default;
    if (data) return data;
  } catch (err) {
    console.warn(`[seed] fixtures/seed-data.ts not loadable (${(err as Error).message}); using inline fallback`);
  }
  return FALLBACK_SEED;
}

/** Every table in the public schema (A's schema.ts + B's schema.intel.ts), except drizzle's journal. */
export async function truncateAll(db: Db): Promise<void> {
  const res = (await db.execute(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
  )) as unknown as { rows?: { tablename: string }[] } | { tablename: string }[];
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  if (rows.length === 0) return;
  await db.execute(sql.raw(`TRUNCATE ${rows.map((r) => `"${r.tablename.replace(/"/g, '""')}"`).join(", ")} RESTART IDENTITY CASCADE`));
}

/** Insert seed data; `reset` truncates first. Sets the demo clock to seed time. */
export async function seedDatabase(db: Db, data: SeedData, opts: { reset: boolean }): Promise<{ userId: string }> {
  if (opts.reset) await truncateAll(db);
  const u = data.user;
  const minBalances = data.profile.reserveRules.minBalances ?? [];
  const reserveHome = minBalances.filter((b) => b.currency === u.homeCurrency).reduce((s, b) => s + b.amountMinor, 0);
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: u.id,
      displayName: u.displayName,
      homeCurrency: u.homeCurrency,
      region: u.region,
      preset: u.preset,
      moneyMode: u.moneyMode,
      overrides: { agentAutonomy: null, paymentPolicy: null, moneyMode: PRESET_DEFAULTS[u.preset].moneyMode === u.moneyMode ? null : u.moneyMode },
      createdAt: new Date(u.createdAt),
    });
    await tx.insert(profiles).values({
      userId: u.id,
      incomes: data.profile.incomes.map((i) => ({ source: i.source, currency: i.currency, amountMinor: i.amountMinor, cadence: i.cadence, nextDate: i.nextDate })),
      notificationMode: data.profile.notificationMode,
      reserveRules: {
        ...data.profile.reserveRules,
        reserves: minBalances.map((b) => ({ currency: b.currency, minMinor: b.amountMinor })),
      },
      caps: { ...DEFAULT_CAPS, reserveMinor: reserveHome || DEFAULT_CAPS.reserveMinor },
      bankProfileId: data.mockBankProfileId,
    });
    if (data.cards.length) await tx.insert(cards).values(data.cards.map((c) => ({ ...c, userId: u.id })));
    if (data.cardFeeProfiles.length) {
      await tx.insert(cardFeeProfiles).values(
        data.cardFeeProfiles.map((f) => ({ cardId: f.cardId, fromCurrency: f.fromCurrency, toCurrency: f.toCurrency, medianMarkupBps: f.medianMarkupBps, fixedFeeMinor: f.fixedFeeMinor, samples: f.samples })),
      );
    }
    for (const p of data.payees) {
      await tx.insert(payees).values({
        id: p.id,
        userId: u.id,
        name: p.name,
        kind: p.kind,
        accountEnc: encryptAccount(u.id, normalizeAccount(p.account)),
        accountHash: accountHash(p.account),
        country: p.country,
        currency: p.currency,
        status: p.status,
        verifiedAt: p.verifiedAt ? new Date(p.verifiedAt) : null,
        coolingUntil: p.coolingUntil ? new Date(p.coolingUntil) : null,
        replacesPayeeId: p.replacesPayeeId,
      });
    }
    if (data.obligations.length) await tx.insert(obligations).values(data.obligations.map((o) => ({ ...o, userId: u.id })));
    if (data.budgets.length) await tx.insert(budgets).values(data.budgets.map((b) => ({ ...b, userId: u.id })));
    for (const t of data.transactions) {
      await tx.insert(transactions).values({
        ...t,
        userId: u.id,
        occurredAt: new Date(t.occurredAt),
        rateUsed: Number(t.rateUsed),
        createdAt: new Date(t.occurredAt),
      });
    }
    // Seeded mandates are NOT inserted: they have no passkey signature yet. Dana signs the rent mandate
    // during onboarding (/onboarding/confirm/options suggests it; /mandates/options + /mandates create it).
    await tx
      .insert(demoState)
      .values({ id: 1, demoUserId: u.id, seededAt: new Date(data.seedNow), demoClaimed: false })
      .onConflictDoUpdate({ target: demoState.id, set: { demoUserId: u.id, seededAt: new Date(data.seedNow), demoClaimed: false } });
  });
  const realNow = clock.nowMs() - clock.offsetMs();
  await clock.setOffset(Date.parse(data.seedNow) - realNow);
  await ledger.append("DEMO_SEEDED", { userId: u.id, seedNow: data.seedNow, payees: data.payees.length, transactions: data.transactions.length });
  return { userId: u.id };
}
