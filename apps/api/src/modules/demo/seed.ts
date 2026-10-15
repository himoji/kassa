/*
 * Seed / reset (spec §18). Inserts fixtures/seed-data.ts (Track D) — or a minimal inline fallback when
 * the fixture is absent — into an EMPTY database (reset truncates every table first), then sets the demo
 * clock so Clock.now() == seed.seedNow (story time, see the fixture header).
 *
 * `personas: true` also inserts the extra demo personas (`seed.personas`, e.g. Li Wei for D-CN3). The seed
 * script, the sim daemon and POST /demo/reset pass it; unit tests that seed Dana alone do not, so their
 * single-user assumptions hold. Dana stays the demo user (demo_state.demo_user_id).
 *
 * AI consent (GDPR Art. 7, p2 B1): seeded users have NO AI consent. Whoever claims the account gives it
 * deliberately (sign-up `aiConsent: true`, or POST /privacy/ai-consent). Tests that drive the agent on a seeded
 * user without a sign-up opt in with `{ aiConsent: true }`.
 * Ledger (p2 B2): one DEMO_SEEDED entry per seeded user, naming only that user, so a DSAR export
 * (payload userId = subject) never contains another persona's identifiers.
 */
import { PRESET_DEFAULTS, type PayeeKind, type RecipientDetails } from "@kassa/shared";
import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import {
  budgets,
  cardFeeProfiles,
  cards,
  demoState,
  inventoryItems,
  merchants,
  obligations,
  payees,
  fundingSources,
  profiles,
  recipes,
  salesDaily,
  stockMovements,
  supplierItems,
  transactions,
  users,
} from "../../db/schema.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { clearDekCache } from "../privacy/keys.ts";
import { accountHash, encryptAccount, encryptDetails, normalizeAccount } from "../payees/crypto.ts";
import { DEFAULT_CAPS } from "../users/service.ts";

type SeedCaps = { perPaymentMinor: number; perDayMinor: number; perMonthMinor: number; smallAutoMinor: number; reserveMinor: number };

/** One seeded user with everything they own (Dana's part of `seed`, or one of `seed.personas`). */
export type SeedUserData = Omit<SeedData, "seedNow" | "homeCurrency" | "personas"> & { profile: SeedData["profile"] & { caps?: SeedCaps } };

/**
 * (added 2026-10-14, Business M0) A BUSINESS persona's merchant: the shop (slug = mock-world storeId), its inventory,
 * recipes, supplier packs (supplierPayeeId = one of the persona's own SUPPLIER payees), 28 days of sales and the
 * append-only stock ledger consistent with them (fixtures/seed-data.ts "Kassa Business").
 */
export type SeedBusinessData = {
  merchant: { id: string; slug: string; name: string; currency: string; region: "EU" | "CN"; timezone: string; poCapMinor: number };
  inventory: readonly { sku: string; name: string; unit: string; safetyStockPct: number; reorderCoverDays: number }[];
  recipes: readonly { menuSku: string; inventorySku: string; qtyPerUnit: number }[];
  supplierItems: readonly {
    id: string;
    supplierPayeeId: string;
    supplierSku: string;
    inventorySku: string;
    packSize: number;
    packPriceMinor: number;
    currency: string;
    minOrderPacks: number;
    leadTimeDays: number;
  }[];
  salesDaily: readonly { day: string; menuSku: string; qty: number; revenueMinor: number }[];
  stockMovements: readonly { id: string; sku: string; kind: "SEED" | "SALE" | "RECEIPT" | "ADJUSTMENT" | "WASTE"; qty: number; occurredAt: string; ref: string | null }[];
};

/** A persona that can be claimed with `demoClaim: "<persona>"` (POST /auth/register/options). */
export type SeedPersonaData = SeedUserData & { persona: string; accountType?: "PERSONAL" | "BUSINESS"; business?: SeedBusinessData };

/** The subset of fixtures/seed-data.ts `seed` this loader uses. */
export type SeedData = {
  seedNow: string;
  homeCurrency: string;
  mockBankProfileId: number;
  /** Extra demo personas (only inserted with `{ personas: true }`). */
  personas?: readonly SeedPersonaData[];
  /** (added 2026-10-16) Linked cards and bank accounts, inserted ACTIVE (simulated). */
  fundingSources?: readonly { id: string; kind: "CARD" | "BANK"; provider: "STRIPE" | "MOCK_BANK"; institution: string; last4: string; country: string; currency: string; providerRef: string }[];
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
    kind: PayeeKind;
    account: string;
    country: string;
    currency: string;
    status: "VERIFIED" | "COOLING" | "BLOCKED";
    verifiedAt: string | null;
    coolingUntil: string | null;
    replacesPayeeId: string | null;
    details?: RecipientDetails;
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
    { id: "8244c30e-61a5-5c07-b556-a9b7706bd087", name: "Landlord in Budapest", kind: "LANDLORD", account: "HU75109183242065038100000003", country: "HU", currency: "HUF", status: "VERIFIED", verifiedAt: "2026-09-02T10:00:00.000Z", coolingUntil: null, replacesPayeeId: null },
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
  // user_keys is truncated too: cached data keys would otherwise seal new entries with keys no row holds.
  clearDekCache();
  if (rows.length === 0) return;
  await db.execute(sql.raw(`TRUNCATE ${rows.map((r) => `"${r.tablename.replace(/"/g, '""')}"`).join(", ")} RESTART IDENTITY CASCADE`));
}

/** Insert one user and everything they own (inside the seed transaction). */
type SeedTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function insertUserData(tx: SeedTx, data: SeedUserData & Pick<SeedPersonaData, "accountType">, aiConsent: boolean): Promise<void> {
  const u = data.user;
  const minBalances = data.profile.reserveRules.minBalances ?? [];
  const reserveHome = minBalances.filter((b) => b.currency === u.homeCurrency).reduce((s, b) => s + b.amountMinor, 0);
  await tx.insert(users).values({
    id: u.id,
    displayName: u.displayName,
    homeCurrency: u.homeCurrency,
    region: u.region,
    preset: u.preset,
    moneyMode: u.moneyMode,
    accountType: data.accountType ?? "PERSONAL",
    // No consent unless the caller asks (tests); a claimed demo account consents at sign-up like any user.
    aiConsentAt: aiConsent ? new Date(u.createdAt) : null,
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
    // DEFAULT_CAPS are KZT-sized (the hero's home currency); other personas bring caps in their own currency.
    caps: data.profile.caps ?? { ...DEFAULT_CAPS, reserveMinor: reserveHome || DEFAULT_CAPS.reserveMinor },
    bankProfileId: data.mockBankProfileId,
  });
  if (data.cards.length) await tx.insert(cards).values(data.cards.map((c) => ({ id: c.id, label: c.label, last4: c.last4, billingCurrency: c.billingCurrency, kind: c.kind, userId: u.id })));
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
      detailsEnc: p.details ? encryptDetails(u.id, p.details) : null,
    });
  }
  for (const f of data.fundingSources ?? []) {
    const at = new Date(data.user.createdAt);
    await tx.insert(fundingSources).values({ ...f, userId: u.id, status: "ACTIVE", simulated: true, linkHash: "seeded", createdAt: at, verifiedAt: at });
  }
  if (data.obligations.length) {
    await tx.insert(obligations).values(
      data.obligations.map((o) => ({ id: o.id, payeeId: o.payeeId, amountMinor: o.amountMinor, currency: o.currency, dueDate: o.dueDate, recurrence: o.recurrence, reference: o.reference, category: o.category, userId: u.id })),
    );
  }
  if (data.budgets.length) {
    await tx.insert(budgets).values(data.budgets.map((b) => ({ id: b.id, category: b.category, periodStart: b.periodStart, periodEnd: b.periodEnd, limitHomeMinor: b.limitHomeMinor, userId: u.id })));
  }
  for (const t of data.transactions) {
    await tx.insert(transactions).values({
      ...t,
      userId: u.id,
      occurredAt: new Date(t.occurredAt),
      rateUsed: Number(t.rateUsed),
      createdAt: new Date(t.occurredAt),
    });
  }
}

/** (added 2026-10-14, Business M0) A BUSINESS persona's merchant rows (after its payees: supplier items reference them). */
async function insertBusinessData(tx: SeedTx, ownerUserId: string, b: SeedBusinessData): Promise<void> {
  const m = b.merchant;
  await tx.insert(merchants).values({ ...m, ownerUserId });
  await tx.insert(inventoryItems).values(b.inventory.map((i) => ({ ...i, merchantId: m.id })));
  await tx.insert(recipes).values(b.recipes.map((r) => ({ ...r, merchantId: m.id })));
  if (b.supplierItems.length) await tx.insert(supplierItems).values(b.supplierItems.map((si) => ({ ...si, merchantId: m.id })));
  // Batched: a shop has ~170 sales rows and ~250 movements.
  for (let i = 0; i < b.salesDaily.length; i += 500) {
    await tx.insert(salesDaily).values(b.salesDaily.slice(i, i + 500).map((s) => ({ ...s, merchantId: m.id })));
  }
  for (let i = 0; i < b.stockMovements.length; i += 500) {
    await tx.insert(stockMovements).values(
      b.stockMovements.slice(i, i + 500).map((mv) => ({ ...mv, merchantId: m.id, occurredAt: new Date(mv.occurredAt), createdAt: new Date(mv.occurredAt) })),
    );
  }
}

/**
 * Insert seed data; `reset` truncates first; `personas` adds `seed.personas`; `aiConsent` pre-grants AI consent to
 * every seeded user (tests only; default false). Sets the demo clock to seed time.
 */
export async function seedDatabase(
  db: Db,
  data: SeedData,
  opts: { reset: boolean; personas?: boolean; aiConsent?: boolean },
): Promise<{ userId: string; personaUserIds: string[] }> {
  if (opts.reset) await truncateAll(db);
  const u = data.user;
  const personas = opts.personas ? (data.personas ?? []) : [];
  await db.transaction(async (tx) => {
    const aiConsent = opts.aiConsent === true;
    await insertUserData(tx, data, aiConsent);
    for (const p of personas) {
      await insertUserData(tx, p, aiConsent);
      if (p.business) await insertBusinessData(tx, p.user.id, p.business);
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
  // One entry per user (p2 B2): each payload names only its own user, so exports stay per subject.
  for (const d of [data as SeedUserData, ...personas]) {
    await ledger.append("DEMO_SEEDED", {
      userId: d.user.id,
      seedNow: data.seedNow,
      payees: d.payees.length,
      transactions: d.transactions.length,
    });
  }
  return { userId: u.id, personaUserIds: personas.map((p) => p.user.id) };
}
