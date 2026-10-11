import { z } from "zod";

import { AiNotice } from "./privacyDto.ts";

import {
  AgentMode,
  BudgetPace,
  CardKind,
  Decision,
  FieldCheck,
  MandatePeriod,
  MandateStatus,
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
} from "./enums.ts";
import { MandateCore } from "./mandate.ts";
import { CanonicalOrder } from "./order.ts";
import { AmountMinor, CurrencyCode, IsoDate, IsoDateTime, paginated, PositiveAmountMinor, Uuid } from "./primitives.ts";
import { ReasonCode } from "./reasonCodes.ts";
import { EffectiveSettings, UserSettings } from "./settings.ts";
import {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "./webauthn.ts";

/*
 * API DTOs for the main endpoints in spec §8 (prefix /api). Responses are server-owned data; the app
 * renders them and does no money maths beyond formatMoney (spec §16).
 */

// ---------- Me / settings ----------

/** GET /me */
export const MeResponse = z.object({
  id: Uuid,
  displayName: z.string(),
  homeCurrency: CurrencyCode,
  region: Region,
  preset: Preset,
  moneyMode: EffectiveSettings.shape.moneyMode,
  notificationMode: NotificationMode,
  frozenAt: IsoDateTime.nullable(),
  settings: UserSettings,
  effective: EffectiveSettings,
  demo: z.object({ agentMode: AgentMode, clockOffsetMs: z.number().int(), now: IsoDateTime }).nullable(),
  /** False until POST /onboarding/confirm succeeded (added by Track C; optional = treated as true). */
  onboarded: z.boolean().optional(),
  /** (added Phase 2) EU AI Act Art. 50 / GDPR Art. 13 notice about the AI and its provider. */
  aiNotice: AiNotice.optional(),
  /** (added Phase 2) when the user consented to AI processing; null = not given (agent/onboarding → 403 AI_CONSENT_REQUIRED). */
  aiConsentAt: IsoDateTime.nullable().optional(),
  /** (added Phase 2) GDPR Art. 18 restriction in force since (null = none). */
  restrictedAt: IsoDateTime.nullable().optional(),
});
export type MeResponse = z.infer<typeof MeResponse>;

/** PATCH /settings result: applied now (tightening) or pending (loosening, I8). */
export const SettingsPatchResponse = z.object({
  settings: UserSettings,
  pending: z.array(
    z.object({
      ruleChangeId: Uuid,
      kind: z.string(),
      direction: RuleChangeDirection,
      effectiveAt: IsoDateTime,
    }),
  ),
});
export type SettingsPatchResponse = z.infer<typeof SettingsPatchResponse>;

// ---------- Money ----------

/** GET /balances */
export const BalancesResponse = z.object({
  homeCurrency: CurrencyCode,
  homeTotalMinor: AmountMinor,
  balances: z.array(
    z.object({
      currency: CurrencyCode,
      amountMinor: AmountMinor,
      homeAmountMinor: AmountMinor,
    }),
  ),
  rateDate: IsoDate.nullable(),
  simulated: z.boolean(),
});
export type BalancesResponse = z.infer<typeof BalancesResponse>;

export const BudgetDto = z.object({
  id: Uuid,
  category: z.string(),
  periodStart: IsoDate,
  periodEnd: IsoDate,
  limitHomeMinor: AmountMinor,
  spentHomeMinor: AmountMinor,
  remainingHomeMinor: AmountMinor,
  daysLeft: z.number().int().nonnegative(),
  pace: BudgetPace,
  projectedRunOutDate: IsoDate.nullable(),
});
export type BudgetDto = z.infer<typeof BudgetDto>;

/** GET /budgets */
export const BudgetsResponse = z.object({ homeCurrency: CurrencyCode, budgets: z.array(BudgetDto) });
export type BudgetsResponse = z.infer<typeof BudgetsResponse>;

/** One ranked funding route (spec §12 route optimizer). */
export const RouteDto = z.object({
  routeId: z.string(),
  label: z.string(),
  fundingCurrency: CurrencyCode,
  rail: Rail,
  feeFixedMinor: AmountMinor,
  feeCurrency: CurrencyCode,
  markupBps: z.number().int().nonnegative(),
  settlementDays: z.number().int().nonnegative(),
  arrivalDate: IsoDate,
  costHomeMinor: AmountMinor,
  savingsVsWorstHomeMinor: AmountMinor,
  /** (added 2026-10-12, Track Y4) funded from the bill's own currency: a direct payment, no conversion. */
  noConversion: z.boolean().optional(),
  /** (added 2026-10-12, Track Y4) false = the balance in fundingCurrency does not cover amount + fees today. */
  balanceCovers: z.boolean().optional(),
});
export type RouteDto = z.infer<typeof RouteDto>;

export const ObligationDto = z.object({
  id: Uuid,
  payeeId: Uuid,
  payeeName: z.string(),
  payeeStatus: PayeeStatus,
  amountMinor: PositiveAmountMinor,
  currency: CurrencyCode,
  homeAmountMinor: AmountMinor,
  dueDate: IsoDate,
  recurrence: Recurrence,
  reference: z.string().nullable(),
  category: z.string(),
  bestRoute: RouteDto.nullable(),
  coverage: z.enum(["COVERED", "SHORTFALL"]),
  mandateId: Uuid.nullable(),
});
export type ObligationDto = z.infer<typeof ObligationDto>;

/** GET /obligations */
export const ObligationsResponse = z.object({ obligations: z.array(ObligationDto) });
export type ObligationsResponse = z.infer<typeof ObligationsResponse>;

/** GET /forecast (spec §12 coverage forecast, days 0..45) */
export const ForecastResponse = z.object({
  horizonDays: z.number().int().positive(),
  asOf: IsoDate,
  currencies: z.array(
    z.object({
      currency: CurrencyCode,
      reserveMinor: AmountMinor,
      points: z.array(z.object({ date: IsoDate, balanceMinor: AmountMinor })),
      shortfall: z.object({ date: IsoDate, amountMinor: AmountMinor }).nullable(),
    }),
  ),
  suggestions: z.array(
    z.object({
      fromCurrency: CurrencyCode,
      toCurrency: CurrencyCode,
      amountMinor: PositiveAmountMinor,
      byDate: IsoDate,
      route: RouteDto.nullable(),
    }),
  ),
});
export type ForecastResponse = z.infer<typeof ForecastResponse>;

export const CardDto = z.object({
  id: Uuid,
  label: z.string(),
  last4: z.string().regex(/^\d{4}$/),
  billingCurrency: CurrencyCode,
  kind: CardKind,
});
export type CardDto = z.infer<typeof CardDto>;

/** GET /cards */
export const CardsResponse = z.object({ cards: z.array(CardDto) });
export type CardsResponse = z.infer<typeof CardsResponse>;

/** GET /cards/fees (fee x-ray, spec §12) */
export const CardFeesResponse = z.object({
  homeCurrency: CurrencyCode,
  profiles: z.array(
    z.object({
      cardId: Uuid,
      fromCurrency: CurrencyCode,
      toCurrency: CurrencyCode,
      medianMarkupBps: z.number().int(),
      fixedFeeMinor: AmountMinor,
      samples: z.number().int().nonnegative(),
    }),
  ),
  monthlyFeesLostHomeMinor: AmountMinor,
  bestCardByCurrency: z.array(z.object({ currency: CurrencyCode, cardId: Uuid })),
  dccWarnings: z.array(
    z.object({
      transactionId: Uuid,
      cardId: Uuid.nullable(),
      merchantNorm: z.string(),
      /** (added 2026-10-12, Track Y6) display name of the merchant (never the normalised key). */
      merchant: z.string().optional(),
      overMidBps: z.number().int(),
    }),
  ),
  exampleValues: z.boolean(),
});
export type CardFeesResponse = z.infer<typeof CardFeesResponse>;

export const TransactionDto = z.object({
  id: Uuid,
  source: TransactionSource,
  occurredAt: IsoDateTime,
  merchantRaw: z.string(),
  merchantNorm: z.string(),
  mcc: z.string().nullable(),
  amountMinor: AmountMinor,
  currency: CurrencyCode,
  cardId: Uuid.nullable(),
  homeAmountMinor: AmountMinor.nullable(),
  rateUsed: z.number().nullable(),
  rateDate: IsoDate.nullable(),
  settledAmountMinor: AmountMinor.nullable(),
  settledCurrency: CurrencyCode.nullable(),
  feeHomeMinor: AmountMinor.nullable(),
  category: z.string().nullable(),
  mergedIntoId: Uuid.nullable(),
  status: TransactionStatus,
});
export type TransactionDto = z.infer<typeof TransactionDto>;

/** GET /transactions?cursor */
export const TransactionsResponse = paginated(TransactionDto);
export type TransactionsResponse = z.infer<typeof TransactionsResponse>;

/** POST /transactions/:id/category */
export const SetTransactionCategoryRequest = z.object({ category: z.string().min(1).max(64) });
export type SetTransactionCategoryRequest = z.infer<typeof SetTransactionCategoryRequest>;

// ---------- Payees and mandates ----------

export const PayeeDto = z.object({
  id: Uuid,
  name: z.string(),
  kind: PayeeKind,
  /** Masked account (e.g. last 4); the full account never leaves the server. */
  accountMasked: z.string(),
  country: z.string().length(2),
  currency: CurrencyCode,
  status: PayeeStatus,
  verifiedAt: IsoDateTime.nullable(),
  coolingUntil: IsoDateTime.nullable(),
  replacesPayeeId: Uuid.nullable(),
});
export type PayeeDto = z.infer<typeof PayeeDto>;

/** GET /payees */
export const PayeesResponse = z.object({ payees: z.array(PayeeDto) });
export type PayeesResponse = z.infer<typeof PayeesResponse>;

/** POST /payees (always created COOLING, I7) */
export const CreatePayeeRequest = z.object({
  name: z.string().min(1).max(140),
  kind: PayeeKind,
  account: z.string().min(4).max(64),
  country: z.string().length(2),
  currency: CurrencyCode,
  replacesPayeeId: Uuid.optional(),
});
export type CreatePayeeRequest = z.infer<typeof CreatePayeeRequest>;

export const MandateDto = z.object({
  id: Uuid,
  payeeIds: z.array(Uuid),
  categories: z.array(z.string()),
  currency: CurrencyCode,
  maxPerPaymentMinor: PositiveAmountMinor,
  maxPerPeriodMinor: PositiveAmountMinor,
  period: MandatePeriod,
  validFrom: IsoDateTime,
  validUntil: IsoDateTime.nullable(),
  mandateHash: z.string(),
  status: MandateStatus,
  effectiveAt: IsoDateTime,
  usedThisPeriodMinor: AmountMinor,
});
export type MandateDto = z.infer<typeof MandateDto>;

/** POST /mandates: the core the user signed (challenge = mandateHash(core)) plus the assertion. */
export const CreateMandateRequest = z.object({
  core: MandateCore,
  assertion: AuthenticationResponseJSON,
});
export type CreateMandateRequest = z.infer<typeof CreateMandateRequest>;

// ---------- Orders / proposals ----------

export const BudgetImpact = z.object({
  category: z.string(),
  homeCurrency: CurrencyCode,
  limitHomeMinor: AmountMinor,
  remainingBeforeHomeMinor: AmountMinor,
  remainingAfterHomeMinor: AmountMinor,
  daysLeft: z.number().int().nonnegative(),
});
export type BudgetImpact = z.infer<typeof BudgetImpact>;

/**
 * GET /orders/:proposalId. The confirmation sheet renders ONLY from `canonicalOrder` plus the
 * server's budget impact and payee status (I3); `webauthnOptions.challenge === orderHash`.
 */
export const OrderView = z.object({
  canonicalOrder: CanonicalOrder,
  orderHash: z.string(),
  webauthnOptions: PublicKeyCredentialRequestOptionsJSON.nullable(),
  budgetImpact: BudgetImpact.nullable(),
  payeeStatus: PayeeStatus,
  decision: Decision,
  reasonCodes: z.array(ReasonCode),
  status: ProposalStatus,
  /** (added 2026-10-12, X8) set when this request re-issued an expired order: the hash it replaced. Show "expired, review again". */
  reissuedFromOrderHash: z.string().optional(),
  /** (added 2026-10-12, X7) HANDOFF orders: the merchant's QR request, checked against the verified payee BEFORE signing. */
  handoff: z
    .object({
      check: z.enum(["MATCH", "QR_PAYEE_MISMATCH"]),
      qrPayeeName: z.string(),
      verifiedPayeeName: z.string(),
      nameSimilarity: z.number().min(0).max(1),
    })
    .optional(),
});
export type OrderView = z.infer<typeof OrderView>;

/** POST /orders/:proposalId/approve */
export const ApproveOrderRequest = z.object({ assertion: AuthenticationResponseJSON });
export type ApproveOrderRequest = z.infer<typeof ApproveOrderRequest>;

export const ApproveOrderResponse = z.object({
  approvalId: Uuid,
  tier: Tier,
  paymentId: Uuid.nullable(),
  paymentStatus: PaymentStatus.nullable(),
  reasonCodes: z.array(ReasonCode),
});
export type ApproveOrderResponse = z.infer<typeof ApproveOrderResponse>;

/** POST /orders/:proposalId/reject */
export const RejectOrderRequest = z.object({ reason: z.string().max(280).optional() });
export type RejectOrderRequest = z.infer<typeof RejectOrderRequest>;

/** Proposal summary card in chat / lists. */
export const ProposalSummary = z.object({
  proposalId: Uuid,
  createdBy: ProposalCreatedBy,
  decision: Decision,
  reasonCodes: z.array(ReasonCode),
  riskScore: z.number().min(0).max(1),
  status: ProposalStatus,
  payeeName: z.string(),
  amountMinor: PositiveAmountMinor,
  currency: CurrencyCode,
  homeAmountMinor: AmountMinor,
  homeCurrency: CurrencyCode,
  createdAt: IsoDateTime,
});
export type ProposalSummary = z.infer<typeof ProposalSummary>;

// ---------- Agent ----------

/** POST /agent/message */
export const AgentMessageRequest = z.object({
  conversationId: Uuid,
  text: z.string().min(1).max(4000),
});
export type AgentMessageRequest = z.infer<typeof AgentMessageRequest>;

/** POST /agent/documents */
export const UploadDocumentResponse = z.object({ docId: z.string() });
export type UploadDocumentResponse = z.infer<typeof UploadDocumentResponse>;

/** Reader field with evidence (spec §9). */
export const ReaderField = z.object({
  value: z.string().nullable(),
  evidence: z.string().nullable(),
  check: FieldCheck,
});
export type ReaderField = z.infer<typeof ReaderField>;

// ---------- Capture ----------

/** POST /capture/event */
export const CaptureEventRequest = z.union([
  z.object({ source: TransactionSource, rawText: z.string().min(1).max(4000) }),
  z.object({
    source: TransactionSource,
    fields: z.object({
      merchant: z.string().min(1),
      amountMinor: PositiveAmountMinor,
      currency: CurrencyCode,
      cardHint: z.string().optional(),
      occurredAt: IsoDateTime.optional(),
    }),
  }),
]);
export type CaptureEventRequest = z.infer<typeof CaptureEventRequest>;

// ---------- Safety ----------

export const NotificationDto = z.object({
  id: Uuid,
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  readAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type NotificationDto = z.infer<typeof NotificationDto>;

/** GET /notifications */
export const NotificationsResponse = z.object({ notifications: z.array(NotificationDto), unread: z.number().int() });
export type NotificationsResponse = z.infer<typeof NotificationsResponse>;

export const LedgerEntryDto = z.object({
  seq: z.number().int().nonnegative(),
  ts: IsoDateTime,
  type: z.string(),
  payload: z.unknown(),
  prevHash: z.string(),
  hash: z.string(),
});
export type LedgerEntryDto = z.infer<typeof LedgerEntryDto>;

/** GET /ledger?cursor */
export const LedgerResponse = paginated(LedgerEntryDto);
export type LedgerResponse = z.infer<typeof LedgerResponse>;

/** POST /freeze */
export const FreezeResponse = z.object({ frozenAt: IsoDateTime });
export type FreezeResponse = z.infer<typeof FreezeResponse>;

/** Error body for every non-2xx response. `code` is a ReasonCode when the refusal is a rule outcome. */
export const ApiError = z.object({
  error: z.string(),
  code: z.union([ReasonCode, z.string()]).optional(),
  reasonCodes: z.array(ReasonCode).optional(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiError>;
