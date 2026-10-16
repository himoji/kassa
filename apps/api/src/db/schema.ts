/*
 * Drizzle schema = spec §6 (every table). Columns the spec lists are kept with the same names; columns
 * added for implementation needs are marked "(added)" and logged in docs/DECISIONS.md.
 *
 * Conventions:
 * - Money: integer minor units (`bigint` in mode "number" — safe up to 2^53) + ISO 4217 code (spec §0).
 * - Timestamps: `timestamptz` (ISO 8601 / RFC 3339 UTC on the wire). Calendar dates: `date` as "YYYY-MM-DD".
 * - IDs: RFC 9562 UUIDs (`gen_random_uuid()` default; callers may pass their own, e.g. mandateId/proposalId).
 * - Enums come from @kassa/shared so DB, API and app agree.
 */
import {
  type ImportHistory,
  AccountType,
  AgentMode,
  CardKind,
  DeviceKind,
  MandatePeriod,
  MandateStatus,
  MoneyMode,
  NotificationMode,
  PayeeKind,
  PayeeStatus,
  PaymentStatus,
  Preset,
  ProposalCreatedBy,
  ProposalStatus,
  PurchaseOrderStatus,
  Rail,
  Recurrence,
  Region,
  RuleChangeDirection,
  ShopOrderChannel,
  StockMovementKind,
  Tier,
  TransactionSource,
  TransactionStatus,
  Decision,
} from "@kassa/shared";
import type { CanonicalOrder, Fulfillment, FulfillmentItem, PurchaseOrderCore, PurchaseOrderLine, ReasonCode, SettingsOverrides } from "@kassa/shared";
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------- enums ----------

/** zod 4 `.options` is a plain array; drizzle's pgEnum wants a non-empty tuple. */
function tuple<T extends string>(values: readonly T[]): [T, ...T[]] {
  if (values.length === 0) throw new Error("empty enum");
  return values as [T, ...T[]];
}

export const regionEnum = pgEnum("region", tuple(Region.options));
export const presetEnum = pgEnum("preset", tuple(Preset.options));
export const moneyModeEnum = pgEnum("money_mode", tuple(MoneyMode.options));
export const notificationModeEnum = pgEnum("notification_mode", tuple(NotificationMode.options));
export const payeeKindEnum = pgEnum("payee_kind", tuple(PayeeKind.options));
export const payeeStatusEnum = pgEnum("payee_status", tuple(PayeeStatus.options));
export const recurrenceEnum = pgEnum("recurrence", tuple(Recurrence.options));
export const cardKindEnum = pgEnum("card_kind", tuple(CardKind.options));
export const transactionSourceEnum = pgEnum("transaction_source", tuple(TransactionSource.options));
export const transactionStatusEnum = pgEnum("transaction_status", tuple(TransactionStatus.options));
export const mandatePeriodEnum = pgEnum("mandate_period", tuple(MandatePeriod.options));
export const mandateStatusEnum = pgEnum("mandate_status", tuple(MandateStatus.options));
export const ruleChangeDirectionEnum = pgEnum("rule_change_direction", tuple(RuleChangeDirection.options));
export const proposalCreatedByEnum = pgEnum("proposal_created_by", tuple(ProposalCreatedBy.options));
export const proposalStatusEnum = pgEnum("proposal_status", tuple(ProposalStatus.options));
export const decisionEnum = pgEnum("decision", tuple(Decision.options));
export const tierEnum = pgEnum("tier", tuple(Tier.options));
export const railEnum = pgEnum("rail", tuple(Rail.options));
export const paymentStatusEnum = pgEnum("payment_status", tuple(PaymentStatus.options));
export const deviceKindEnum = pgEnum("device_kind", tuple(DeviceKind.options));
export const agentModeEnum = pgEnum("agent_mode", tuple(AgentMode.options));
// (added 2026-10-14, Business M0, migration 0007)
export const accountTypeEnum = pgEnum("account_type", tuple(AccountType.options));
export const purchaseOrderStatusEnum = pgEnum("purchase_order_status", tuple(PurchaseOrderStatus.options));
export const stockMovementKindEnum = pgEnum("stock_movement_kind", tuple(StockMovementKind.options));
export const shopOrderChannelEnum = pgEnum("shop_order_channel", tuple(ShopOrderChannel.options));

const money = (name: string) => bigint(name, { mode: "number" });
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const isoDate = (name: string) => date(name, { mode: "string" });

// ---------- JSON shapes (stored as jsonb) ----------

export type IncomeJson = {
  source: string;
  currency: string;
  amountMinor: number;
  cadence: "WEEKLY" | "MONTHLY" | "TERM" | "ONCE";
  nextDate: string;
};

/**
 * Protected-reserve rules (spec §6 "reserveRules JSON"; shape from fixtures/seed-data.ts): minimum
 * balances per currency (minor units) and obligation categories to protect. Rules step 5 uses the
 * home-currency total in caps.reserveMinor; the forecast may use per-currency minimums.
 */
/** (added) Where a captured spend happened and the likely place (capture/place.ts). Coordinates rounded to ~100 m. */
export type PlaceJson = {
  name?: string;
  kind?: string;
  source?: "DICTIONARY" | "PAYEE" | "CLEANED" | "AI";
  processor?: string;
  street?: string;
  city?: string;
  country?: string;
  lat?: number;
  lon?: number;
};

export type ReserveRulesJson = {
  /** Per-currency minimums used by the fx forecast (Track B). The seed fills it from minBalances. */
  reserves?: { currency: string; minMinor: number }[];
  protectObligationCategories?: string[];
  minBalances?: { currency: string; amountMinor: number }[];
};

/** Rules caps in home-currency minor units (spec §10 step 5, step 9) — @kassa/shared CapsDto minus currency. (added) */
export type CapsJson = {
  perPaymentMinor: number;
  perDayMinor: number;
  perMonthMinor: number;
  smallAutoMinor: number;
  /** Protected reserve: total home-currency balance may not drop below this. */
  reserveMinor: number;
};

/** Stored WebAuthn assertion (AuthenticationResponseJSON) plus the credential id it names. */
export type AssertionJson = Record<string, unknown> & { id: string };

// ---------- tables ----------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name").notNull(),
  homeCurrency: text("home_currency").notNull().default("KZT"),
  region: regionEnum("region").notNull().default("EU"),
  preset: presetEnum("preset").notNull().default("ASK_ME"),
  moneyMode: moneyModeEnum("money_mode").notNull().default("PAY_IN_PLACE"),
  /** Advanced-switch overrides (null = follow preset). (added) */
  overrides: jsonb("overrides")
    .$type<SettingsOverrides>()
    .notNull()
    .default({ agentAutonomy: null, paymentPolicy: null, moneyMode: null }),
  frozenAt: tstz("frozen_at"),
  createdAt: tstz("created_at").notNull().defaultNow(),
  /** (added, Phase 2) consent to AI processing (GDPR Art. 6(1)(a)/7); null = none → agent/onboarding refuse. */
  aiConsentAt: tstz("ai_consent_at"),
  /**
   * (added 2026-10-12, Track Y3, migration 0005) separate consent to the cross-border transfer of personal
   * information for AI processing (PIPL Art. 38–39); required for region CN when a model runs outside Kassa's server.
   */
  piplConsentAt: tstz("pipl_consent_at"),
  /** (added, Phase 2) GDPR Art. 18 restriction of processing (implies frozen, no AI processing). */
  restrictedAt: tstz("restricted_at"),
  /** (added, Phase 2) GDPR Art. 17 erasure done: DEK shredded, personal rows deleted; sessions refused. */
  erasedAt: tstz("erased_at"),
  /** (added 2026-10-14, Business M0, migration 0007) BUSINESS = owns a merchant (Kassa Business mode in the app). */
  accountType: accountTypeEnum("account_type").notNull().default("PERSONAL"),
  /**
   * (added, migration 0009) Sign-in with a backup code replaced every passkey: sessions issued before this instant
   * are refused (a lost or stolen device stays signed out).
   */
  sessionsRevokedAt: tstz("sessions_revoked_at"),
});

/**
 * (added, migration 0009) Backup codes: one-time codes that let the owner register a new passkey when every passkey
 * is lost. Only an HMAC-SHA256 of each code (keyed with SESSION_SECRET) is stored; codes are high-entropy random
 * strings, so a keyed hash is enough (no slow hash needed). A new set deletes the old one.
 */
export const recoveryCodes = pgTable(
  "recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    createdAt: tstz("created_at").notNull().defaultNow(),
    usedAt: tstz("used_at"),
  },
  (t) => [uniqueIndex("recovery_codes_hash_uq").on(t.codeHash), index("recovery_codes_user_idx").on(t.userId)],
);

/**
 * (added) Short-lived, single-use auth state (auth/challenges.ts, auth/pair.ts). In Postgres rather than process
 * memory so the request that creates an entry and the one that consumes it may hit different API instances (Vercel
 * Functions). Taking an entry is `DELETE ... RETURNING` (atomic, at most one taker); expiry is checked against the
 * Clock (demo offset included) in code, and expired rows are swept on each insert.
 */
export const webauthnChallenges = pgTable(
  "webauthn_challenges",
  {
    /** The WebAuthn challenge itself (random ≥16 bytes, base64url); it doubles as the challengeId. */
    challenge: text("challenge").primaryKey(),
    /** "register" | "login" | "recover". */
    purpose: text("purpose").notNull(),
    /** The rest of the pending entry (register: userId, displayName, existingUser; recover: userId, codeId). */
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    expiresAt: tstz("expires_at").notNull(),
  },
  (t) => [index("webauthn_challenges_expires_idx").on(t.expiresAt)],
);

/** Passkey-gated writes: the challenge is the hash of `payload`, the exact server-built change. */
export const gatedChallenges = pgTable(
  "gated_challenges",
  {
    /** Opaque challengeId (16 random bytes, base64url). */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    hash: text("hash").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    expiresAt: tstz("expires_at").notNull(),
  },
  (t) => [index("gated_challenges_expires_idx").on(t.expiresAt)],
);

/** KassaLite pairing codes, stored as sha256 (base64url) of the normalized code, never in plaintext. */
export const pairCodes = pgTable(
  "pair_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: tstz("expires_at").notNull(),
  },
  (t) => [index("pair_codes_expires_idx").on(t.expiresAt)],
);

/**
 * (added, Phase 2) Per-user data encryption key (DEK) for personal fields in append-only stores (ledger
 * payload `pii`). The DEK is wrapped (AES-256-GCM, NIST SP 800-38D) with USER_KEK; erasure (GDPR Art. 17)
 * nulls `wrappedDek` — crypto-shredding — and the row stays as a tombstone so a new key is never minted.
 */
export const userKeys = pgTable("user_keys", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** "v1.<iv>.<ciphertext>.<tag>" (base64url); null once shredded. */
  wrappedDek: text("wrapped_dek"),
  /** Identifies the KEK that wrapped the DEK (rotation): base64url(sha256(KEK))[0..16]. */
  kekId: text("kek_id").notNull(),
  createdAt: tstz("created_at").notNull().defaultNow(),
  shreddedAt: tstz("shredded_at"),
});

export const profiles = pgTable("profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  incomes: jsonb("incomes").$type<IncomeJson[]>().notNull().default([]),
  notificationMode: notificationModeEnum("notification_mode").notNull().default("EACH"),
  reserveRules: jsonb("reserve_rules").$type<ReserveRulesJson>().notNull().default({}),
  /** (added) caps used by rules step 5/9. */
  caps: jsonb("caps").$type<CapsJson>(),
  /** (added) passkey-signed base rules (onboarding confirm): the signed core, its hash (= WebAuthn challenge), the assertion. */
  baseRules: jsonb("base_rules").$type<Record<string, unknown>>(),
  baseRulesHash: text("base_rules_hash"),
  baseRulesAssertion: jsonb("base_rules_assertion").$type<AssertionJson>(),
  baseRulesSignedAt: tstz("base_rules_signed_at"),
  /** (added) mock bank (Wise-shaped) integer profile id of the user's capped wallet. */
  bankProfileId: bigint("bank_profile_id", { mode: "number" }),
  /** (added) Stripe Issuing cardholder (created once per user, spec §11 step 1). */
  stripeCardholderId: text("stripe_cardholder_id"),
  /** (added 2026-10-15) What the user's imported bank statements showed (dataport/history.ts), for the agent. */
  moneyHistory: jsonb("money_history").$type<ImportHistory>(),
});

const credentialColumns = () => ({
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** base64url credential ID (W3C WebAuthn L3 §5.1 rawId). */
  credentialId: text("credential_id").notNull(),
  /** base64url COSE public key. */
  publicKey: text("public_key").notNull(),
  counter: bigint("counter", { mode: "number" }).notNull().default(0),
  transports: jsonb("transports").$type<string[]>().notNull().default([]),
  createdAt: tstz("created_at").notNull().defaultNow(),
});

export const webauthnCredentialsRules = pgTable("webauthn_credentials_rules", credentialColumns(), (t) => [
  uniqueIndex("webauthn_credentials_rules_cred_uq").on(t.credentialId),
]);

/** Separate table, written only through the payments module (I2). */
export const webauthnCredentialsPayments = pgTable("webauthn_credentials_payments", credentialColumns(), (t) => [
  uniqueIndex("webauthn_credentials_payments_cred_uq").on(t.credentialId),
]);

export const payees = pgTable(
  "payees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: payeeKindEnum("kind").notNull(),
    /**
     * AES-256-GCM (NIST SP 800-38D) ciphertext of the account details. NULL (with accountHash NULL) = no account
     * yet: a payee captured from the onboarding chat, kept COOLING with no coolingUntil and never payable (0006).
     */
    accountEnc: text("account_enc"),
    /** base64url(sha256(normalized account)); NULL when accountEnc is NULL. */
    accountHash: text("account_hash"),
    country: text("country").notNull(),
    currency: text("currency").notNull(),
    status: payeeStatusEnum("status").notNull().default("COOLING"),
    verifiedAt: tstz("verified_at"),
    coolingUntil: tstz("cooling_until"),
    replacesPayeeId: uuid("replaces_payee_id"),
    /**
     * (0013) Recipient details (student ID, customer number, relationship…; shared/recipient.ts), AES-256-GCM like
     * the account but under its own AAD (payees/crypto.ts). NULL = none given. Never where money goes.
     */
    detailsEnc: text("details_enc"),
    /** (0013) Removed by the user: hidden from lists and never payable again. Kept for the ledger and old orders. */
    archivedAt: tstz("archived_at"),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [index("payees_user_idx").on(t.userId)],
);

/**
 * (0014) Linked cards and bank accounts the user sends from (shared/fundingSource.ts). `providerRef` is the Stripe
 * PaymentMethod id (pm_…) or the mock bank's account reference; `providerCustomer` the Stripe customer (cus_…).
 * Only the last 4 characters of a card or account number are stored. A bank link waits (PENDING) for the passkey
 * and the one-tenge code (`codeHash`, sha256, at most 5 tries); REMOVED rows stay for the ledger and old orders.
 */
export const fundingSources = pgTable(
  "funding_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"CARD" | "BANK">().notNull(),
    provider: text("provider").$type<"STRIPE" | "MOCK_BANK">().notNull(),
    institution: text("institution").notNull(),
    last4: text("last4").notNull(),
    country: text("country").notNull(),
    currency: text("currency").notNull(),
    status: text("status").$type<"PENDING" | "ACTIVE" | "REMOVED">().notNull().default("PENDING"),
    simulated: boolean("simulated").notNull().default(true),
    providerRef: text("provider_ref"),
    providerCustomer: text("provider_customer"),
    linkHash: text("link_hash").notNull(),
    codeHash: text("code_hash"),
    codeAttempts: integer("code_attempts").notNull().default(0),
    createdAt: tstz("created_at").notNull().defaultNow(),
    verifiedAt: tstz("verified_at"),
    removedAt: tstz("removed_at"),
  },
  (t) => [index("funding_sources_user_idx").on(t.userId)],
);

export const obligations = pgTable(
  "obligations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    payeeId: uuid("payee_id")
      .notNull()
      .references(() => payees.id),
    amountMinor: money("amount_minor").notNull(),
    currency: text("currency").notNull(),
    dueDate: isoDate("due_date").notNull(),
    recurrence: recurrenceEnum("recurrence").notNull(),
    reference: text("reference"),
    category: text("category").notNull(),
  },
  (t) => [index("obligations_user_due_idx").on(t.userId, t.dueDate)],
);

export const budgets = pgTable("budgets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  periodStart: isoDate("period_start").notNull(),
  periodEnd: isoDate("period_end").notNull(),
  limitHomeMinor: money("limit_home_minor").notNull(),
});

export const cards = pgTable("cards", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  last4: text("last4").notNull(),
  billingCurrency: text("billing_currency").notNull(),
  kind: cardKindEnum("kind").notNull(),
});

export const cardFeeProfiles = pgTable(
  "card_fee_profiles",
  {
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    fromCurrency: text("from_currency").notNull(),
    toCurrency: text("to_currency").notNull(),
    medianMarkupBps: integer("median_markup_bps").notNull(),
    fixedFeeMinor: money("fixed_fee_minor").notNull().default(0),
    samples: integer("samples").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.fromCurrency, t.toCurrency] })],
);

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: transactionSourceEnum("source").notNull(),
    occurredAt: tstz("occurred_at").notNull(),
    merchantRaw: text("merchant_raw").notNull(),
    merchantNorm: text("merchant_norm").notNull(),
    /** ISO 18245 merchant category code. */
    mcc: text("mcc"),
    amountMinor: money("amount_minor").notNull(),
    currency: text("currency").notNull(),
    cardId: uuid("card_id").references(() => cards.id),
    homeAmountMinor: money("home_amount_minor"),
    /** Mid rate used (display/audit only; amounts are integers). */
    rateUsed: doublePrecision("rate_used"),
    rateDate: isoDate("rate_date"),
    settledAmountMinor: money("settled_amount_minor"),
    settledCurrency: text("settled_currency"),
    feeHomeMinor: money("fee_home_minor"),
    category: text("category"),
    dedupeKey: text("dedupe_key"),
    mergedIntoId: uuid("merged_into_id"),
    status: transactionStatusEnum("status").notNull().default("PENDING"),
    /** (added) link for KASSA_PAYMENT rows. */
    paymentId: uuid("payment_id"),
    /** (added) where the tap happened and the likely place (capture/place.ts PlaceJson); null when unknown. */
    place: jsonb("place").$type<PlaceJson>(),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("transactions_user_occurred_idx").on(t.userId, t.occurredAt),
    index("transactions_dedupe_idx").on(t.dedupeKey),
  ],
);

export const mandates = pgTable(
  "mandates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    payeeIds: jsonb("payee_ids").$type<string[]>().notNull(),
    categories: jsonb("categories").$type<string[]>().notNull(),
    currency: text("currency").notNull(),
    maxPerPaymentMinor: money("max_per_payment_minor").notNull(),
    maxPerPeriodMinor: money("max_per_period_minor").notNull(),
    period: mandatePeriodEnum("period").notNull(),
    validFrom: tstz("valid_from").notNull(),
    validUntil: tstz("valid_until"),
    mandateHash: text("mandate_hash").notNull(),
    /** Null for a seeded mandate the user has not signed yet: such a mandate never authorises T1. */
    userAssertion: jsonb("user_assertion").$type<AssertionJson>(),
    status: mandateStatusEnum("status").notNull(),
    effectiveAt: tstz("effective_at").notNull(),
    revokedAt: tstz("revoked_at"),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [index("mandates_user_idx").on(t.userId)],
);

export const ruleChanges = pgTable(
  "rule_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    before: jsonb("before").notNull(),
    after: jsonb("after").notNull(),
    direction: ruleChangeDirectionEnum("direction").notNull(),
    /** WebAuthn assertion over `changeHash`; required for LOOSEN before it can ever apply (I8). */
    assertion: jsonb("assertion").$type<AssertionJson>(),
    /** (added) base64url(sha256(JCS(change core))) — the passkey challenge for a loosening. */
    changeHash: text("change_hash").notNull(),
    /** Null until signed (LOOSEN); TIGHTEN rows get effectiveAt = now. */
    effectiveAt: tstz("effective_at"),
    appliedAt: tstz("applied_at"),
    /** (added) superseded / cancelled. */
    canceledAt: tstz("canceled_at"),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [index("rule_changes_user_idx").on(t.userId)],
);

export type ProposalDraftJson = {
  payeeId: string;
  amountMinor: number;
  currency: string;
  purpose: string;
  rail?: string;
  items?: unknown[];
  category?: string;
  agentRequestedConfirm?: boolean;
  readerChecks?: {
    amount?: "VERIFIED" | "UNVERIFIED";
    account?: "VERIFIED" | "UNVERIFIED";
    nonCriticalUnverified?: boolean;
  };
  triggerOrigin?: boolean;
  obligationId?: string;
  dueDate?: string;
  riskFeatures?: Record<string, number>;
  /** (added 2026-10-11, B1) documents whose persisted Reader checks were applied (I10). */
  sourceDocIds?: string[];
  /**
   * (added 2026-10-14, Business M0) A merchant order this payment buys (shop delivery or till bill): the merchant slug
   * (= mock-world storeId), channel and line items; the order signs `itemsHash(items)` (CanonicalOrder.itemsHash).
   */
  fulfillment?: Fulfillment;
  /** (added 2026-10-14, Business M0) The signed supplier purchase order this payment settles (CanonicalOrder.purchaseOrderId). */
  purchaseOrderId?: string;
  /**
   * (added 2026-10-12, X7) HANDOFF orders: the merchant's QR request fetched and checked against the verified payee
   * when the order was first shown, BEFORE the passkey prompt; the handoff rail pays exactly this QR.
   */
  handoffQr?: {
    qrPaymentId: string;
    qrPayeeName: string;
    verifiedPayeeName: string;
    nameSimilarity: number;
    check: "MATCH" | "QR_PAYEE_MISMATCH";
    qrPayload: string;
    walletUrl: string | null;
    qrAmountMinor: number;
    qrCurrency: string;
    checkedAt: string;
  };
  /** (linked accounts) the linked card or bank the user chose to pay from. */
  fundingSourceId?: string;
};

export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdBy: proposalCreatedByEnum("created_by").notNull(),
    draft: jsonb("draft").$type<ProposalDraftJson>().notNull(),
    decision: decisionEnum("decision").notNull(),
    reasonCodes: jsonb("reason_codes").$type<ReasonCode[]>().notNull().default([]),
    riskScore: doublePrecision("risk_score").notNull(),
    canonicalOrder: jsonb("canonical_order").$type<CanonicalOrder>(),
    orderHash: text("order_hash"),
    status: proposalStatusEnum("status").notNull(),
    /** (added) for budget impact / mandate scope lookups. */
    category: text("category").notNull(),
    /** (added) scheduler idempotency: one proposal per obligation due date. */
    obligationId: uuid("obligation_id"),
    createdAt: tstz("created_at").notNull().defaultNow(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("proposals_user_idx").on(t.userId), index("proposals_obligation_idx").on(t.obligationId)],
);

/**
 * (added 2026-10-11, B4) Settlement record per obligation period: the one proposal that is paying it.
 * PENDING = awaiting approval or execution; PAID = executed (payment created). A rejected order or a
 * failed / canceled payment deletes its row, which releases the period. The primary key
 * (obligation_id, period) is the idempotency key: a second live proposal for the same period cannot exist.
 */
export const obligationSettlements = pgTable(
  "obligation_settlements",
  {
    obligationId: uuid("obligation_id")
      .notNull()
      .references(() => obligations.id, { onDelete: "cascade" }),
    /** The obligation's due date for this period (ISO 8601). */
    period: isoDate("period").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    status: text("status").$type<"PENDING" | "PAID">().notNull(),
    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.obligationId, t.period] }), uniqueIndex("obligation_settlements_proposal_uq").on(t.proposalId)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id),
    orderHash: text("order_hash").notNull(),
    tier: tierEnum("tier").notNull(),
    /** base64url Ed25519 signature (RFC 8032) over JCS({orderHash,tier,issuedAt,expiresAt,keyId}). */
    approvalSig: text("approval_sig").notNull(),
    keyId: text("key_id").notNull(),
    userAssertion: jsonb("user_assertion").$type<AssertionJson>(),
    mandateId: uuid("mandate_id"),
    issuedAt: tstz("issued_at").notNull(),
    expiresAt: tstz("expires_at").notNull(),
  },
  (t) => [index("approvals_proposal_idx").on(t.proposalId)],
);

/** I4: the PK makes replay impossible. */
export const usedNonces = pgTable("used_nonces", {
  nonce: text("nonce").primaryKey(),
  usedAt: tstz("used_at").notNull(),
});

/**
 * (added, I13) Mock-world webhook replay protection inside the 5-minute window: one row per accepted
 * signed delivery. `sigHash` = hex SHA-256 of `${X-Kassa-Timestamp}.${X-Kassa-Signature}` (primary key, so a
 * second delivery of the same signed request fails the insert). `signedAt` is the sender's timestamp; rows
 * older than the window are purged by the scheduler (webhooks/replay.ts).
 */
export const webhookSeenSignatures = pgTable(
  "webhook_seen_signatures",
  {
    sigHash: text("sig_hash").primaryKey(),
    kind: text("kind").notNull(),
    signedAt: tstz("signed_at").notNull(),
    receivedAt: tstz("received_at").notNull(),
  },
  (t) => [index("webhook_seen_signatures_signed_at_idx").on(t.signedAt)],
);

export type PaymentDetailsJson = Record<string, unknown>;

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    approvalId: uuid("approval_id")
      .notNull()
      .references(() => approvals.id),
    rail: railEnum("rail").notNull(),
    railRef: text("rail_ref"),
    status: paymentStatusEnum("status").notNull(),
    amountMinor: money("amount_minor").notNull(),
    currency: text("currency").notNull(),
    createdAt: tstz("created_at").notNull(),
    /** (added) independent daily cap (I5) needs user + home amount without joining rules tables. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    proposalId: uuid("proposal_id").notNull(),
    homeAmountMinor: money("home_amount_minor").notNull(),
    homeCurrency: text("home_currency").notNull(),
    /** (added) rail-specific details (handoff QR check, PaymentIntent id, card id). */
    details: jsonb("details").$type<PaymentDetailsJson>().notNull().default({}),
    reasonCodes: jsonb("reason_codes").$type<ReasonCode[]>().notNull().default([]),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [index("payments_user_created_idx").on(t.userId, t.createdAt), index("payments_rail_ref_idx").on(t.railRef)],
);

export const issuedCards = pgTable("issued_cards", {
  stripeCardId: text("stripe_card_id").primaryKey(),
  approvalId: uuid("approval_id")
    .notNull()
    .references(() => approvals.id),
  expectedMerchantNorm: text("expected_merchant_norm").notNull(),
  maxAmountMinor: money("max_amount_minor").notNull(),
  currency: text("currency").notNull(),
  expiresAt: tstz("expires_at").notNull(),
  usedAt: tstz("used_at"),
  canceledAt: tstz("canceled_at"),
  /** (added) */
  paymentId: uuid("payment_id").notNull(),
  userId: uuid("user_id").notNull(),
  provider: text("provider").notNull(),
  last4: text("last4"),
  createdAt: tstz("created_at").notNull(),
});

export const ledgerEntries = pgTable("ledger_entries", {
  seq: bigint("seq", { mode: "number" }).primaryKey(),
  ts: tstz("ts").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  prevHash: text("prev_hash").notNull(),
  hash: text("hash").notNull(),
});

export const ledgerCheckpoints = pgTable("ledger_checkpoints", {
  seq: bigint("seq", { mode: "number" }).primaryKey(),
  headHash: text("head_hash").notNull(),
  sig: text("sig").notNull(),
  keyId: text("key_id").notNull(),
  ts: tstz("ts").notNull(),
});

/**
 * (added 2026-10-12, X6) Signed head anchor: a single row (id = 1) rewritten in the same transaction as every
 * append, so truncating or re-hashing entries after the last checkpoint is detected (ledger/internal.ts verifyChain).
 * sig = Ed25519 (LEDGER_CHECKPOINT_KEY) over a domain-separated JCS message (headMessage), never a checkpoint's.
 */
export const ledgerHead = pgTable("ledger_head", {
  id: integer("id").primaryKey().default(1),
  seq: bigint("seq", { mode: "number" }).notNull(),
  headHash: text("head_hash").notNull(),
  sig: text("sig").notNull(),
  keyId: text("key_id").notNull(),
  ts: tstz("ts").notNull(),
});

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>(),
    readAt: tstz("read_at"),
    createdAt: tstz("created_at").notNull(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

/** Server-only (I11). */
export const placeholderMaps = pgTable(
  "placeholder_maps",
  {
    conversationId: text("conversation_id").notNull(),
    /** (added 2026-10-13) owner of the conversation; lookups filter on it. Backfilled from conversations. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    placeholder: text("placeholder").notNull(),
    kind: text("kind").notNull(),
    realRef: text("real_ref").notNull(),
    /** (added, Phase 2) for the retention purge (RETENTION_DAYS_PLACEHOLDER_MAPS). */
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.placeholder] })],
);

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  kind: deviceKindEnum("kind").notNull(),
  /** IOS_SHORTCUT: base64url(sha256(bearer token)), the token is shown once. APP: sha256 of the push token. */
  tokenHash: text("token_hash").notNull().unique(),
  /** (added) APP devices: Expo push token (needed to send pushes); null for Shortcut devices. */
  pushToken: text("push_token"),
  /** (added) */
  platform: text("platform"),
  createdAt: tstz("created_at").notNull().defaultNow(),
  revokedAt: tstz("revoked_at"),
});

/** Singleton row (id = 1). */
export const demoState = pgTable("demo_state", {
  id: integer("id").primaryKey().default(1),
  clockOffsetMs: bigint("clock_offset_ms", { mode: "number" }).notNull().default(0),
  /** (added 2026-10-16) REAL = the system clock; DEMO = system clock + clockOffsetMs (the offset is kept either way). */
  clockMode: text("clock_mode", { enum: ["REAL", "DEMO"] }).notNull().default("REAL"),
  agentMode: agentModeEnum("agent_mode").notNull().default("LIVE"),
  seededAt: tstz("seeded_at"),
  /** (added) seeded hero user a reviewer can claim with their first passkey. */
  demoUserId: uuid("demo_user_id"),
  /** (added) */
  demoClaimed: boolean("demo_claimed").notNull().default(false),
});


/**
 * (added 2026-10-16) Demo only: a row = this user turned the 24 h waits off (recipient cooling, loosening delays) with
 * their passkey. Ignored unless DEMO_ENABLED (modules/demo/cooling.ts); deleting the row turns the waits back on.
 */
export const demoCoolingOff = pgTable("demo_cooling_off", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  credentialId: text("credential_id").notNull(),
  offAt: tstz("off_at").notNull(),
});

// ---------- Kassa Business (added 2026-10-14, Business M0, migration 0007) ----------
/*
 * A BUSINESS user owns one merchant (a pizzeria). Stock is never stored as a number: on-hand = the sum of
 * `stock_movements.qty` per (merchant, sku), and movements are append-only (no UPDATE/DELETE in code; a correction is
 * an ADJUSTMENT row). Inventory quantities are integers in the item's unit (pcs, g, ml). Money: minor units + ISO 4217.
 */

export const merchants = pgTable(
  "merchants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Equals the mock-world storeId (e.g. "bud", "sha"): the storefront, till and kitchen screen of this merchant. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    currency: text("currency").notNull(),
    region: regionEnum("region").notNull(),
    /** IANA time zone: "today"/"tomorrow" for sales and the forecast are calendar days here. */
    timezone: text("timezone").notNull(),
    /** A purchase order above this total is refused before it can be signed (M5). */
    poCapMinor: money("po_cap_minor").notNull(),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("merchants_slug_uq").on(t.slug), index("merchants_owner_idx").on(t.ownerUserId)],
);

export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    /** "pcs" | "g" | "ml": the unit of every quantity of this SKU. */
    unit: text("unit").notNull(),
    /** Extra stock kept on top of forecast demand, in percent of that demand. */
    safetyStockPct: integer("safety_stock_pct").notNull().default(10),
    /** How many days of demand a reorder should cover. */
    reorderCoverDays: integer("reorder_cover_days").notNull().default(3),
  },
  (t) => [uniqueIndex("inventory_items_merchant_sku_uq").on(t.merchantId, t.sku)],
);

/** Bill of materials: one menu item uses `qtyPerUnit` of an inventory SKU (in that SKU's unit). */
export const recipes = pgTable(
  "recipes",
  {
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    menuSku: text("menu_sku").notNull(),
    inventorySku: text("inventory_sku").notNull(),
    qtyPerUnit: integer("qty_per_unit").notNull(),
  },
  (t) => [primaryKey({ columns: [t.merchantId, t.menuSku, t.inventorySku] })],
);

/** What a supplier (a SUPPLIER payee of the owner) sells this merchant: packs of an inventory SKU. */
export const supplierItems = pgTable(
  "supplier_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    supplierPayeeId: uuid("supplier_payee_id")
      .notNull()
      .references(() => payees.id, { onDelete: "cascade" }),
    /** The supplier's catalog SKU (mock-world SUPPLIERS[x].items[].sku), e.g. "BOX-33CM-100". */
    supplierSku: text("supplier_sku").notNull(),
    inventorySku: text("inventory_sku").notNull(),
    /** Inventory units per pack (100 boxes, 40 dough balls, 2500 g). */
    packSize: integer("pack_size").notNull(),
    /** Snapshot of the catalog pack price; a PO re-reads the structured catalog price when it is drafted (M5). */
    packPriceMinor: money("pack_price_minor").notNull(),
    currency: text("currency").notNull(),
    minOrderPacks: integer("min_order_packs").notNull().default(1),
    leadTimeDays: integer("lead_time_days").notNull().default(1),
  },
  (t) => [
    uniqueIndex("supplier_items_merchant_supplier_sku_uq").on(t.merchantId, t.supplierPayeeId, t.supplierSku),
    index("supplier_items_merchant_inventory_idx").on(t.merchantId, t.inventorySku),
  ],
);

/** Append-only. qty is signed: SEED / RECEIPT / positive ADJUSTMENT add, SALE / WASTE / negative ADJUSTMENT subtract. */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    kind: stockMovementKindEnum("kind").notNull(),
    qty: integer("qty").notNull(),
    occurredAt: tstz("occurred_at").notNull(),
    /** What caused it: a shop order id, a purchase order id, a sales day ("2026-10-26"), "seed". */
    ref: text("ref"),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [index("stock_movements_merchant_sku_idx").on(t.merchantId, t.sku, t.occurredAt)],
);

/** Units sold per menu SKU per calendar day (merchant timezone). The forecast's history. */
export const salesDaily = pgTable(
  "sales_daily",
  {
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    day: isoDate("day").notNull(),
    menuSku: text("menu_sku").notNull(),
    qty: integer("qty").notNull(),
    revenueMinor: money("revenue_minor").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.merchantId, t.day, t.menuSku] })],
);

/** The signed / delivered / invoiced state of a PO; `invoice` is what the supplier sent (untrusted until matched, M5). */
export type PurchaseOrderInvoiceJson = {
  invoiceId: string;
  supplierName: string;
  amountMinor: number;
  currency: string;
  /** base64url(sha256(normalized account)) of the account the invoice asks to be paid. */
  accountHash: string;
  issuedAt: string;
  reference?: string | null;
};

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    supplierPayeeId: uuid("supplier_payee_id")
      .notNull()
      .references(() => payees.id),
    status: purchaseOrderStatusEnum("status").notNull().default("DRAFT"),
    /** "AGENT" | "SCHEDULER" | "USER": who drafted it (a draft never moves money). */
    createdBy: text("created_by").notNull(),
    currency: text("currency").notNull(),
    lines: jsonb("lines").$type<PurchaseOrderLine[]>().notNull(),
    totalMinor: money("total_minor").notNull(),
    /** The forecast the draft was computed from (shown to the owner, hashed into core.forecastHash). */
    forecastSnapshot: jsonb("forecast_snapshot").$type<Record<string, unknown>>(),
    reasonCodes: jsonb("reason_codes").$type<ReasonCode[]>().notNull().default([]),
    /** Set when signed: the exact core, its hash (= WebAuthn challenge) and the owner's payments-passkey assertion. */
    core: jsonb("core").$type<PurchaseOrderCore>(),
    poHash: text("po_hash"),
    ownerAssertion: jsonb("owner_assertion").$type<AssertionJson>(),
    signedAt: tstz("signed_at"),
    invoice: jsonb("invoice").$type<PurchaseOrderInvoiceJson>(),
    obligationId: uuid("obligation_id"),
    proposalId: uuid("proposal_id"),
    /** [{status, at}] in order. */
    timeline: jsonb("timeline").$type<{ status: string; at: string; note?: string }[]>().notNull().default([]),
    createdAt: tstz("created_at").notNull().defaultNow(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("purchase_orders_merchant_idx").on(t.merchantId, t.createdAt), uniqueIndex("purchase_orders_po_hash_uq").on(t.poHash)],
);

/** A consumer's order at a merchant (delivery or till bill) paid through Kassa; the shop's status timeline. */
export const shopOrders = pgTable(
  "shop_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The paying Kassa user (customer). */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** mock-world storeId; `merchantId` is set when the shop is a Kassa Business merchant (stock goes down by recipe). */
    merchantSlug: text("merchant_slug").notNull(),
    merchantId: uuid("merchant_id").references(() => merchants.id, { onDelete: "set null" }),
    channel: shopOrderChannelEnum("channel").notNull(),
    /** The shop's order id (DELIVERY) once submitted. */
    externalOrderId: text("external_order_id"),
    /** The till's bill id (TILL). */
    billId: text("bill_id"),
    items: jsonb("items").$type<FulfillmentItem[]>().notNull(),
    totalMinor: money("total_minor").notNull(),
    currency: text("currency").notNull(),
    /** RECEIVED → ACCEPTED → COOKING → OUT_FOR_DELIVERY → DELIVERED (DELIVERY) | PAID (TILL) | FAILED | CANCELED. */
    status: text("status").notNull(),
    timeline: jsonb("timeline").$type<{ status: string; at: string; note?: string }[]>().notNull().default([]),
    proposalId: uuid("proposal_id"),
    paymentId: uuid("payment_id"),
    createdAt: tstz("created_at").notNull().defaultNow(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("shop_orders_user_idx").on(t.userId, t.createdAt),
    uniqueIndex("shop_orders_slug_external_uq").on(t.merchantSlug, t.externalOrderId),
    uniqueIndex("shop_orders_slug_bill_uq").on(t.merchantSlug, t.billId),
    index("shop_orders_proposal_idx").on(t.proposalId),
  ],
);
