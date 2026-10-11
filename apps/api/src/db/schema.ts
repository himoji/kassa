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
  Rail,
  Recurrence,
  Region,
  RuleChangeDirection,
  Tier,
  TransactionSource,
  TransactionStatus,
  Decision,
} from "@kassa/shared";
import type { CanonicalOrder, ReasonCode, SettingsOverrides } from "@kassa/shared";
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
  /** (added, Phase 2) GDPR Art. 18 restriction of processing (implies frozen, no AI processing). */
  restrictedAt: tstz("restricted_at"),
  /** (added, Phase 2) GDPR Art. 17 erasure done: DEK shredded, personal rows deleted; sessions refused. */
  erasedAt: tstz("erased_at"),
});

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
    /** AES-256-GCM (NIST SP 800-38D) ciphertext of the account details. */
    accountEnc: text("account_enc").notNull(),
    /** base64url(sha256(normalized account)). */
    accountHash: text("account_hash").notNull(),
    country: text("country").notNull(),
    currency: text("currency").notNull(),
    status: payeeStatusEnum("status").notNull().default("COOLING"),
    verifiedAt: tstz("verified_at"),
    coolingUntil: tstz("cooling_until"),
    replacesPayeeId: uuid("replaces_payee_id"),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [index("payees_user_idx").on(t.userId)],
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
  agentMode: agentModeEnum("agent_mode").notNull().default("LIVE"),
  seededAt: tstz("seeded_at"),
  /** (added) seeded hero user a reviewer can claim with their first passkey. */
  demoUserId: uuid("demo_user_id"),
  /** (added) */
  demoClaimed: boolean("demo_claimed").notNull().default(false),
});

