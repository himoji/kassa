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
import { isKnownCurrency } from "./money.ts";
import { AccountType } from "./purchaseOrder.ts";
import { CanonicalOrder } from "./order.ts";
import { ORDER_LINE_STANCES } from "./orderText.ts";
import { AmountMinor, CurrencyCode, IsoDate, IsoDateTime, paginated, PositiveAmountMinor, Uuid } from "./primitives.ts";
import { ReasonCode } from "./reasonCodes.ts";
import { RecipientCategory, RecipientDetails } from "./recipient.ts";
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
  demo: z
    .object({
      agentMode: AgentMode,
      clockOffsetMs: z.number().int(),
      clockMode: z.enum(["REAL", "DEMO"]),
      now: IsoDateTime,
      /** This user turned the 24 h waits off (POST /demo/cooling): the app shows a banner while true. */
      coolingOff: z.boolean(),
    })
    .nullable(),
  /** False until POST /onboarding/confirm succeeded (added by Track C; optional = treated as true). */
  onboarded: z.boolean().optional(),
  /** (added Phase 2) EU AI Act Art. 50 / GDPR Art. 13 notice about the AI and its provider. */
  aiNotice: AiNotice.optional(),
  /** (added Phase 2) when the user consented to AI processing; null = not given (agent/onboarding → 403 AI_CONSENT_REQUIRED). */
  aiConsentAt: IsoDateTime.nullable().optional(),
  /** (added Phase 2) GDPR Art. 18 restriction in force since (null = none). */
  restrictedAt: IsoDateTime.nullable().optional(),
  /** (added 2026-10-14, Business M4) BUSINESS = owns a merchant; the app shows the business tabs. Optional = PERSONAL. */
  accountType: AccountType.optional(),
});
export type MeResponse = z.infer<typeof MeResponse>;

/** PATCH /settings result: applied now (tightening) or pending (loosening, I8). */
export const SettingsPatchResponse = z.object({
  settings: UserSettings,
  /** (Y6, p2 B6, additive) implicit changes a preset switch causes, e.g. moneyMode CAPPED_WALLET -> PAY_IN_PLACE. */
  derivedChanges: z.array(z.object({ setting: z.string(), from: z.string(), to: z.string() })).default([]),
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

/**
 * (added 2026-10-18) One conversion that makes a bill payable: buy `amountMinor` of `toCurrency` from the `fromCurrency`
 * balance (estimated debit incl. the route's fee and markup), via the bank route `routeId`.
 */
export const ConversionPlanStep = z.object({
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode,
  amountMinor: PositiveAmountMinor,
  estimatedDebitMinor: PositiveAmountMinor,
  routeId: z.string(),
});
export type ConversionPlanStep = z.infer<typeof ConversionPlanStep>;

/** (added 2026-10-19) The state of a bill's current period (apps/api obligations/status.ts). */
export const ObligationPeriodStatus = z.enum(["DUE", "AWAITING_APPROVAL", "IN_FLIGHT", "PAID"]);
export type ObligationPeriodStatus = z.infer<typeof ObligationPeriodStatus>;

export const ObligationDto = z.object({
  id: Uuid,
  payeeId: Uuid,
  payeeName: z.string(),
  payeeStatus: PayeeStatus,
  /** (added 2026-10-13) The payee has no account details yet (bill captured in onboarding): unpayable until added. */
  payeeAccountMissing: z.boolean(),
  amountMinor: PositiveAmountMinor,
  currency: CurrencyCode,
  homeAmountMinor: AmountMinor,
  dueDate: IsoDate,
  recurrence: Recurrence,
  reference: z.string().nullable(),
  category: z.string(),
  bestRoute: RouteDto.nullable(),
  /**
   * UNKNOWN (added 2026-10-18): balances unknown or the funding check failed; never reported as COVERED.
   * CONVERTIBLE (added 2026-10-18): no single balance pays the bill, but the user's balances together do: convert first
   * (`conversions`, each its own passkey-signed CONVERT order), then the bill is paid from its own currency.
   */
  coverage: z.enum(["COVERED", "CONVERTIBLE", "SHORTFALL", "UNKNOWN"]),
  conversions: z.array(ConversionPlanStep).optional(),
  /** (added 2026-10-18) SHORTFALL because paying would take the wallet below the protected reserve (rules: REFUSE_CAP). */
  reserveBreached: z.boolean().optional(),
  mandateId: Uuid.nullable(),
  /**
   * (added 2026-10-19) Where the bill's current period (`dueDate`) stands: DUE, AWAITING_APPROVAL (an order waits for the
   * passkey), IN_FLIGHT (approved, payment on its way) or PAID (delivered). A settled period is not checked for coverage
   * (COVERED, no route) and not counted by the forecast; a recurring one continues on `nextDueDate`.
   */
  status: ObligationPeriodStatus,
  /** The order and payment holding the period, when one does. */
  proposalId: Uuid.nullable().optional(),
  paymentId: Uuid.nullable().optional(),
  /** When the payment was delivered (PAID). */
  paidAt: IsoDateTime.nullable().optional(),
  /** Recurring bill whose current period is settled: the next period's due date. */
  nextDueDate: IsoDate.nullable().optional(),
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
      /**
       * The daily spending the projection subtracts, and where it comes from: the last 30 days, or the imported bank
       * history (the median month) when the last 30 days have too few spending days to say.
       */
      burn: z.object({ dailyMinor: AmountMinor, from: z.enum(["recent", "history"]) }).optional(),
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
  /** Empty for a card learned from an Apple Pay tap whose hint had no digits ("Revolut"). */
  last4: z.string().regex(/^(\d{4})?$/),
  billingCurrency: CurrencyCode,
  kind: CardKind,
});
export type CardDto = z.infer<typeof CardDto>;

/**
 * POST /cards: a card added by hand. Only the last 4 digits (to tell cards apart and match notifications and Apple
 * Pay taps to them); Kassa never takes a full card number, expiry or CVV.
 */
export const CreateCardRequest = z.object({
  label: z.string().trim().min(1).max(60),
  last4: z.string().regex(/^\d{4}$/, "exactly the last 4 digits"),
  billingCurrency: CurrencyCode.refine(isKnownCurrency, "unknown ISO 4217 currency"),
  kind: CardKind,
});
export type CreateCardRequest = z.infer<typeof CreateCardRequest>;

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
  /** Masked account (e.g. last 4); the full account never leaves the server. "" when `accountMissing`. */
  accountMasked: z.string(),
  /** (added 2026-10-13) No account details yet (payee captured in onboarding): COOLING and never payable until added. */
  accountMissing: z.boolean(),
  country: z.string().length(2),
  currency: CurrencyCode,
  status: PayeeStatus,
  verifiedAt: IsoDateTime.nullable(),
  coolingUntil: IsoDateTime.nullable(),
  replacesPayeeId: Uuid.nullable(),
  /** (added 2026-10-15) Recipient category, derived from `kind` (shared/recipient.ts). */
  category: RecipientCategory,
  /** (added 2026-10-15) What this category asks for (student ID, customer number…); null when none was given. */
  details: RecipientDetails.nullable(),
  /** (added 2026-10-15) A tuition recipient added from the school directory: its portal page for this student. */
  portalLink: z.string().url().nullable().optional(),
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
  /** (added 2026-10-15) Must belong to the kind's category (detailsFitKind). */
  details: RecipientDetails.optional(),
});
export type CreatePayeeRequest = z.infer<typeof CreatePayeeRequest>;

/** PATCH /payees/:id (added 2026-10-15): details only. The account, name and currency never change in place (I7). */
export const UpdatePayeeRequest = z.object({ details: RecipientDetails.nullable() });
export type UpdatePayeeRequest = z.infer<typeof UpdatePayeeRequest>;

/** POST /obligations (added 2026-10-15): a bill or a schedule (rent, wages, support) to a recipient. */
export const CreateObligationRequest = z.object({
  payeeId: Uuid,
  amountMinor: PositiveAmountMinor,
  currency: CurrencyCode,
  dueDate: IsoDate,
  recurrence: z.enum(["MONTHLY", "ONCE"]),
  reference: z.string().trim().min(1).max(140).optional(),
});
export type CreateObligationRequest = z.infer<typeof CreateObligationRequest>;

/** POST /obligations/:id/pay (added 2026-10-15): pay a bill now instead of waiting for it to fall due. */
export const PayObligationRequest = z.object({ fundingSourceId: Uuid.optional() });
export type PayObligationRequest = z.infer<typeof PayObligationRequest>;

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
  /** (added 2026-10-16) Measured time from approval to the bank reporting the money delivered (SENT), when it was. */
  deliveredInMs: z.number().int().nonnegative().optional(),
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
  /** (added 2026-10-18) PAYMENT, or CONVERT (an exchange between the user's own balances). Absent = PAYMENT. */
  kind: z.enum(["PAYMENT", "CONVERT"]).optional(),
  /** (added 2026-10-18) The signed funding binding: which balance pays, at most how much (fees included), by which route. */
  funding: z
    .object({ currency: CurrencyCode, maxAmountMinor: PositiveAmountMinor, routeId: z.string(), markupBps: z.number().int().nonnegative() })
    .optional(),
  /**
   * (added 2026-10-18) One sentence the server builds from the signed canonical order (amount, payee, funding balance,
   * maximum debit, route). The chat shows it under the assistant's reply, so the user reads what is signed, not the
   * model's paraphrase of it.
   */
  orderLine: z.string().optional(),
  /**
   * (added 2026-10-19) The same order as structured fields, so the app words the line in the user's language: how it
   * is introduced (`stance`: to sign, signed, paid under a mandate or the small-payment limit, or a plain order), the
   * rail, whether a linked account pays (else the `funding` balance), and a conversion's own amounts. Absent for a
   * refused order (no line) and on cards stored before it existed (the English `orderLine` is shown then).
   */
  orderFacts: z
    .object({
      stance: z.enum(ORDER_LINE_STANCES),
      rail: z.union([Rail, z.literal("CONVERT")]),
      linkedAccount: z.boolean(),
      conversion: z
        .object({ fromCurrency: CurrencyCode, toCurrency: CurrencyCode, amountMinor: PositiveAmountMinor, maxDebitMinor: PositiveAmountMinor, routeId: z.string() })
        .optional(),
    })
    .optional(),
});
export type ProposalSummary = z.infer<typeof ProposalSummary>;

// ---------- Agent ----------

/** POST /agent/message */
export const AgentMessageRequest = z.object({
  conversationId: Uuid,
  text: z.string().min(1).max(4000),
  /** (added 2026-10-13) The user's pick for a `data-choices` part (appDto ChoiceAnswer); validated server-side. */
  choice: z
    .object({
      id: z.string().min(1).max(64),
      optionId: z.string().min(1).max(32).optional(),
      optionIds: z.array(z.string().min(1).max(32)).max(8).optional(),
      value: z.string().max(40).optional(),
    })
    .optional(),
  /** (added 2026-10-20) The device's IANA time zone and UI language, so the agent knows the user's "today". */
  timeZone: z.string().min(1).max(64).optional(),
  locale: z.string().min(2).max(35).optional(),
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

/**
 * GET /notifications/wait?cursor (long poll): answers as soon as the feed differs from `cursor`, or after about 25 s
 * with `changed: false`. No cursor answers at once. Pass the returned `cursor` to the next call.
 */
export const NotificationsWaitResponse = NotificationsResponse.extend({ cursor: z.string(), changed: z.boolean() });
export type NotificationsWaitResponse = z.infer<typeof NotificationsWaitResponse>;

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
