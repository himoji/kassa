import { z } from "zod";

import {
  AgentMode,
  CardKind,
  IncomeCadence,
  MoneyMode,
  MandatePeriod,
  NotificationMode,
  PayeeKind,
  Preset,
  ProposalStatus,
  Recurrence,
  Region,
  RuleChangeDirection,
  TransactionSource,
} from "./enums.ts";
import { MandateCore } from "./mandate.ts";

import { BudgetImpact, MandateDto, ProposalSummary, RouteDto } from "./dto.ts";
import { AmountMinor, CurrencyCode, IsoDate, IsoDateTime, PositiveAmountMinor, Uuid } from "./primitives.ts";
import { ReasonCode } from "./reasonCodes.ts";
import { SettingsPatch, UserSettings } from "./settings.ts";
import {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "./webauthn.ts";

/*
 * App-facing DTOs that spec §8/§16 imply but `dto.ts` did not define yet (added by Track C, mobile).
 * Additive only: existing fields never change meaning.
 * Where the spec is silent the cited standard applies (noted per item).
 */

const B64url = z.string().regex(/^[A-Za-z0-9_-]*$/, "base64url");

// ---------- WebAuthn creation options (W3C WebAuthn L3 §5.4, JSON form) ----------

export const PublicKeyCredentialCreationOptionsJSON = z.looseObject({
  rp: z.looseObject({ id: z.string().optional(), name: z.string() }),
  user: z.looseObject({ id: B64url, name: z.string(), displayName: z.string() }),
  challenge: B64url,
  pubKeyCredParams: z.array(z.looseObject({ type: z.literal("public-key"), alg: z.number().int() })),
  timeout: z.number().int().positive().optional(),
  excludeCredentials: z
    .array(
      z.looseObject({
        id: B64url,
        type: z.literal("public-key"),
        transports: z.array(AuthenticatorTransport).optional(),
      }),
    )
    .optional(),
  authenticatorSelection: z.looseObject({}).optional(),
  attestation: z.enum(["none", "indirect", "direct", "enterprise"]).optional(),
});
export type PublicKeyCredentialCreationOptionsJSON = z.infer<typeof PublicKeyCredentialCreationOptionsJSON>;

/**
 * Which session transport the caller wants (spec §8): `web` = httpOnly cookie, `native` = bearer
 * JWT (15 min, RFC 7519) + rotating refresh token returned in the body.
 */
export const ClientKind = z.enum(["web", "native"]);
export type ClientKind = z.infer<typeof ClientKind>;

// ---------- Auth (spec §8 "Auth and session") ----------

/** POST /auth/register/options */
export const RegisterOptionsRequest = z.object({ displayName: z.string().min(1).max(80) });
export type RegisterOptionsRequest = z.infer<typeof RegisterOptionsRequest>;
export const RegisterOptionsResponse = z.object({
  /** Opaque id the server keyed the pending challenge under; echo it in /verify. */
  challengeId: z.string().min(1),
  options: PublicKeyCredentialCreationOptionsJSON,
});
export type RegisterOptionsResponse = z.infer<typeof RegisterOptionsResponse>;

/** POST /auth/register/verify */
export const RegisterVerifyRequest = z.object({
  challengeId: z.string().min(1),
  response: RegistrationResponseJSON,
  client: ClientKind,
  /** (added Phase 2) consent to AI processing given on the registration screen (GDPR Art. 6(1)(a), 7). */
  aiConsent: z.boolean().optional(),
});
export type RegisterVerifyRequest = z.infer<typeof RegisterVerifyRequest>;

/** POST /auth/login/options (body may be empty: discoverable credentials) */
export const LoginOptionsResponse = z.object({
  challengeId: z.string().min(1),
  options: PublicKeyCredentialRequestOptionsJSON,
});
export type LoginOptionsResponse = z.infer<typeof LoginOptionsResponse>;

/** POST /auth/login/verify */
export const LoginVerifyRequest = z.object({
  challengeId: z.string().min(1),
  response: AuthenticationResponseJSON,
  client: ClientKind,
});
export type LoginVerifyRequest = z.infer<typeof LoginVerifyRequest>;

/** Bearer tokens for native clients. `null` for web (the session is an httpOnly cookie). */
export const SessionTokens = z.object({
  accessToken: z.string().min(1),
  /** RFC 3339 expiry of the access token (15 min). */
  accessTokenExpiresAt: IsoDateTime,
  refreshToken: z.string().min(1),
});
export type SessionTokens = z.infer<typeof SessionTokens>;

/** Response of register/verify and login/verify. */
export const AuthSessionResponse = z.object({
  user: z.object({ id: Uuid, displayName: z.string() }),
  /** False until POST /onboarding/confirm succeeded: the app routes to onboarding. */
  onboarded: z.boolean(),
  tokens: SessionTokens.nullable(),
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponse>;

// ---------- Backup (recovery) codes: sign in again when every passkey is lost ----------

/** GET /auth/recovery-codes: how many unused codes are left (the codes themselves are shown once). */
export const RecoveryCodesStatus = z.object({
  remaining: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  createdAt: IsoDateTime.nullable(),
});
export type RecoveryCodesStatus = z.infer<typeof RecoveryCodesStatus>;

/** POST /auth/recovery-codes: a new set (the old one stops working). Passkey round trip (HTTP 428) first. */
export const RecoveryCodesGenerateRequest = z.object({
  challengeId: z.string().optional(),
  assertion: AuthenticationResponseJSON.optional(),
});
export type RecoveryCodesGenerateRequest = z.infer<typeof RecoveryCodesGenerateRequest>;
export const RecoveryCodesResponse = z.object({ codes: z.array(z.string()), createdAt: IsoDateTime });
export type RecoveryCodesResponse = z.infer<typeof RecoveryCodesResponse>;

/** POST /auth/recovery/options: a backup code → options to register a new passkey for that account. */
export const RecoveryOptionsRequest = z.object({ code: z.string().trim().min(8).max(32) });
export type RecoveryOptionsRequest = z.infer<typeof RecoveryOptionsRequest>;

/** POST /auth/recovery/verify: the new passkey replaces every old one; payments freeze (unfreeze: passkey + 24 h). */
export const RecoveryVerifyRequest = z.object({
  challengeId: z.string().min(1),
  response: RegistrationResponseJSON,
  client: ClientKind,
});
export type RecoveryVerifyRequest = z.infer<typeof RecoveryVerifyRequest>;
export const RecoveryVerifyResponse = AuthSessionResponse.extend({
  recovery: z.object({ codesLeft: z.number().int().nonnegative(), paymentsFrozen: z.boolean() }),
});
export type RecoveryVerifyResponse = z.infer<typeof RecoveryVerifyResponse>;

/** POST /auth/refresh (native). Refresh tokens rotate on every use (OAuth 2.0 Security BCP, RFC 9700 §4.14). */
export const RefreshRequest = z.object({ refreshToken: z.string().min(1) });
export type RefreshRequest = z.infer<typeof RefreshRequest>;
export const RefreshResponse = SessionTokens;
export type RefreshResponse = z.infer<typeof RefreshResponse>;

/** POST /auth/logout: body `{ refreshToken? }`; clears the cookie on web. 204. */
export const LogoutRequest = z.object({ refreshToken: z.string().optional() });
export type LogoutRequest = z.infer<typeof LogoutRequest>;

/**
 * Generic "sign this" envelope for passkey-gated writes other than orders. The server builds the
 * thing to be signed and returns its challenge; the client only ever signs server-issued options.
 */
export const PasskeyChallenge = z.object({
  challengeId: z.string().min(1),
  webauthnOptions: PublicKeyCredentialRequestOptionsJSON,
});
export type PasskeyChallenge = z.infer<typeof PasskeyChallenge>;

// ---------- Caps, rule changes (spec §10 caps, I8) ----------

/** Rule caps, all in the home currency. The payments module keeps its own independent cap (I5). */
export const CapsDto = z.object({
  currency: CurrencyCode,
  perPaymentMinor: PositiveAmountMinor,
  perDayMinor: PositiveAmountMinor,
  perMonthMinor: PositiveAmountMinor,
  /** Smart preset auto-pay limit (spec §10 rule 9, default ₸10,000). */
  smallAutoMinor: AmountMinor,
  /** Protected reserve that payments may not dip into. */
  reserveMinor: AmountMinor,
});
export type CapsDto = z.infer<typeof CapsDto>;

/** GET /caps */
export const CapsResponse = z.object({ caps: CapsDto });
export type CapsResponse = z.infer<typeof CapsResponse>;

export const CapsPatch = CapsDto.omit({ currency: true }).partial();
export type CapsPatch = z.infer<typeof CapsPatch>;

/**
 * PATCH /settings body as the app sends it: the settings patch, an optional caps patch, and - when
 * the change loosens anything (I8) - the passkey assertion over the challenge the server returned
 * in its first answer (HTTP 428 Precondition Required, RFC 6585 §3, body = ApiError with
 * `code: "PASSKEY_REQUIRED"` and `details: PasskeyChallenge`).
 */
export const SettingsPatchRequest = SettingsPatch.extend({
  caps: CapsPatch.optional(),
  challengeId: z.string().optional(),
  assertion: AuthenticationResponseJSON.optional(),
});
export type SettingsPatchRequest = z.infer<typeof SettingsPatchRequest>;

export const RuleChangeDto = z.object({
  id: Uuid,
  kind: z.string(),
  direction: RuleChangeDirection,
  before: z.unknown(),
  after: z.unknown(),
  createdAt: IsoDateTime,
  effectiveAt: IsoDateTime,
  appliedAt: IsoDateTime.nullable(),
});
export type RuleChangeDto = z.infer<typeof RuleChangeDto>;

/** GET /rule-changes?status=pending */
export const RuleChangesResponse = z.object({ changes: z.array(RuleChangeDto) });
export type RuleChangesResponse = z.infer<typeof RuleChangesResponse>;

// ---------- Mandates (list + server-built core to sign) ----------

/** GET /mandates */
export const MandatesResponse = z.object({ mandates: z.array(MandateDto) });
export type MandatesResponse = z.infer<typeof MandatesResponse>;

/**
 * POST /mandates/options: the server fills mandateId/userId/validFrom, normalises (sorted, unique)
 * and returns the core plus WebAuthn options whose challenge = mandateHash(core). The app then
 * POSTs /mandates { core, assertion } (CreateMandateRequest).
 */
export const MandateOptionsRequest = z.object({
  payeeIds: z.array(Uuid).min(1),
  categories: z.array(z.string().min(1)).min(1),
  currency: CurrencyCode,
  maxPerPaymentMinor: PositiveAmountMinor,
  maxPerPeriodMinor: PositiveAmountMinor,
  period: MandatePeriod,
  validUntil: IsoDateTime.nullable(),
});
export type MandateOptionsRequest = z.infer<typeof MandateOptionsRequest>;
export const MandateOptionsResponse = z.object({
  core: MandateCore,
  mandateHash: z.string(),
  webauthnOptions: PublicKeyCredentialRequestOptionsJSON,
});
export type MandateOptionsResponse = z.infer<typeof MandateOptionsResponse>;

// ---------- Proposals ----------

/** GET /proposals?status=PENDING_APPROVAL - pending sign-offs (e.g. scheduler-created bills). */
export const ProposalsResponse = z.object({ proposals: z.array(ProposalSummary) });
export type ProposalsResponse = z.infer<typeof ProposalsResponse>;

export const ProposalStatusFilter = ProposalStatus;

/**
 * GET /agent/activity: what the agent and the scheduler proposed in the last days and what became of each, for the
 * Home card. Outcome: PAID_AUTO = paid inside a signed mandate or small-auto limit; PAID_APPROVED = paid after the
 * user's passkey; WAITING = waiting for the passkey; HELD = refused by the rules (reasonCodes say why); DECLINED = the
 * user said no; OTHER = expired, failed or handed off.
 */
export const AgentOutcome = z.enum(["PAID_AUTO", "PAID_APPROVED", "WAITING", "HELD", "DECLINED", "OTHER"]);
export type AgentOutcome = z.infer<typeof AgentOutcome>;
export const AgentActivityResponse = z.object({
  since: IsoDateTime,
  counts: z.record(AgentOutcome, z.number().int().nonnegative()),
  items: z.array(
    z.object({
      proposalId: z.string().uuid(),
      createdBy: z.enum(["AGENT", "SCHEDULER"]),
      outcome: AgentOutcome,
      payeeName: z.string(),
      amountMinor: z.number().int(),
      currency: CurrencyCode,
      reasonCodes: z.array(ReasonCode),
      createdAt: IsoDateTime,
    }),
  ),
});
export type AgentActivityResponse = z.infer<typeof AgentActivityResponse>;

// ---------- Onboarding (spec §8 onboarding) ----------

export const OnboardingIncomeDraft = z.object({
  source: z.string().min(1).max(80),
  currency: CurrencyCode,
  amountMinor: PositiveAmountMinor,
  cadence: IncomeCadence,
  nextDate: IsoDate.nullable(),
});
export const OnboardingObligationDraft = z.object({
  payeeName: z.string().min(1).max(140),
  payeeKind: PayeeKind,
  amountMinor: PositiveAmountMinor,
  currency: CurrencyCode,
  dueDate: IsoDate.nullable(),
  recurrence: Recurrence,
  category: z.string(),
});
export const OnboardingBudgetDraft = z.object({ category: z.string(), limitHomeMinor: PositiveAmountMinor });
export const OnboardingCardDraft = z.object({
  label: z.string(),
  last4: z.string().regex(/^\d{4}$/),
  billingCurrency: CurrencyCode,
  kind: CardKind,
});

/** Structured profile draft the onboarding chat builds up (every field optional until known). */
export const OnboardingProfileDraft = z.object({
  displayName: z.string().nullable(),
  homeCurrency: CurrencyCode.nullable(),
  region: Region.nullable(),
  preset: Preset.nullable(),
  moneyMode: MoneyMode.nullable(),
  notificationMode: NotificationMode.nullable(),
  incomes: z.array(OnboardingIncomeDraft),
  obligations: z.array(OnboardingObligationDraft),
  budgets: z.array(OnboardingBudgetDraft),
  cards: z.array(OnboardingCardDraft),
});
export type OnboardingProfileDraft = z.infer<typeof OnboardingProfileDraft>;

// ---------- Choices (agent-triggered UI) ----------

export const ChoiceOption = z.object({
  id: z.string().min(1).max(32),
  label: z.string().min(1).max(60),
  /** Aliases a user may say or type (voice-ready); matched server-side. */
  spoken: z.array(z.string()).optional(),
  value: z.string(),
});
export type ChoiceOption = z.infer<typeof ChoiceOption>;

/** One row of an "amounts" picker (e.g. a monthly budget per category): a labelled slider with a suggested value. */
export const AmountsItem = z.object({
  id: z.string().min(1).max(32),
  label: z.string().min(1).max(60),
  emoji: z.string().max(16).optional(),
  defaultMinor: z.number().int().nonnegative(),
  minMinor: z.number().int().nonnegative().optional(),
  maxMinor: z.number().int().optional(),
  stepMinor: z.number().int().positive().optional(),
});
export type AmountsItem = z.infer<typeof AmountsItem>;

/**
 * `data-choices` part: the assistant asks the user to pick instead of type. kind "choice" / "confirm" carry options;
 * "amount" carries a currency + slider bounds; "amounts" several labelled amounts set together (one answer for all);
 * "date" a date range. `answer` is set once the user answered (history),
 * and the card turns read-only.
 */
export const DataChoices = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(["choice", "confirm", "amount", "amounts", "date"]).default("choice"),
  prompt: z.string(),
  options: z.array(ChoiceOption),
  multi: z.boolean().optional(),
  allowOther: z.boolean().optional(),
  /** With `allowOther`: what the typed answer is ("currency": the app offers every ISO 4217 code to pick from). */
  otherKind: z.enum(["text", "currency"]).optional(),
  amount: z
    .object({ currency: CurrencyCode, defaultMinor: z.number().int().optional(), minMinor: z.number().int().optional(), maxMinor: z.number().int().optional(), stepMinor: z.number().int().optional() })
    .optional(),
  /** `purpose: "budgets"`: item ids are budget categories and the app applies the confirmed values (PUT /budgets). */
  amounts: z.object({ currency: CurrencyCode, items: z.array(AmountsItem).min(1).max(12), purpose: z.enum(["budgets"]).optional() }).optional(),
  date: z.object({ min: IsoDate.optional(), max: IsoDate.optional(), default: IsoDate.optional() }).optional(),
  answer: z.object({ optionIds: z.array(z.string()), value: z.string().optional(), label: z.string() }).optional(),
});
export type DataChoices = z.infer<typeof DataChoices>;

/**
 * The user's pick for a `data-choices` part, sent with the message. Options are referenced by id (the server
 * rejects ids that are not in the stored part); "amount" / "date" send `value` (minor units / YYYY-MM-DD);
 * "amounts" sends `values`, one per item id (minor units).
 */
export const ChoiceAnswer = z.object({
  id: z.string().min(1).max(64),
  optionId: z.string().min(1).max(32).optional(),
  optionIds: z.array(z.string().min(1).max(32)).max(8).optional(),
  value: z.string().max(40).optional(),
  values: z.array(z.object({ id: z.string().min(1).max(32), value: z.string().max(20) })).max(12).optional(),
});
export type ChoiceAnswer = z.infer<typeof ChoiceAnswer>;

/**
 * PUT /budgets: this month's limit per category (home currency), applied at once. Raising one loosens the rules (a
 * bigger budget lowers the risk score), so it needs a passkey first (HTTP 428 round trip, as SettingsPatchRequest).
 */
export const BudgetsSetRequest = z.object({
  budgets: z
    .array(z.object({ category: z.string().regex(/^[a-z0-9_]{1,32}$/), limitHomeMinor: PositiveAmountMinor }))
    .min(1)
    .max(20),
  challengeId: z.string().optional(),
  assertion: AuthenticationResponseJSON.optional(),
});
export type BudgetsSetRequest = z.infer<typeof BudgetsSetRequest>;
export const BudgetsSetResponse = z.object({
  /** Categories whose limit changed. */
  applied: z.array(z.string()),
});
export type BudgetsSetResponse = z.infer<typeof BudgetsSetResponse>;

/** POST /onboarding/message */
export const OnboardingMessageRequest = z.object({
  conversationId: Uuid,
  text: z.string().min(1).max(4000),
  choice: ChoiceAnswer.optional(),
});
export type OnboardingMessageRequest = z.infer<typeof OnboardingMessageRequest>;
export const OnboardingMessageResponse = z.object({
  reply: z.string(),
  draft: OnboardingProfileDraft,
  /** True once the draft has everything needed for the review screen. */
  complete: z.boolean(),
  /** Pickers for this turn (rendered with the same ChoiceCard as the agent chat). */
  ui: z.array(DataChoices).default([]),
  /** This reply came from a recorded replay (REPLAY mode, or LIVE fell back because the model was unavailable). */
  replay: z.boolean().default(false),
});
export type OnboardingMessageResponse = z.infer<typeof OnboardingMessageResponse>;

/**
 * The passkey-signed base rules. challenge = base64url(sha256(JCS(core))) (same scheme as
 * orderHash, RFC 8785 + FIPS 180-4).
 */
export const BaseRulesCore = z.object({
  v: z.literal(1),
  userId: Uuid,
  settings: UserSettings,
  caps: CapsDto,
});
export type BaseRulesCore = z.infer<typeof BaseRulesCore>;

/** POST /onboarding/confirm/options { conversationId } -> the server-built core to review and sign. */
export const OnboardingConfirmOptionsRequest = z.object({
  conversationId: Uuid,
  /** Edits made on the review sheet before signing: the caps to sign, and budget limits for the draft's categories. */
  caps: CapsPatch.optional(),
  budgets: z.array(z.object({ category: z.string(), limitHomeMinor: PositiveAmountMinor })).max(20).optional(),
  /** Budgets the user added by hand on the review sheet (categories the draft does not have yet). */
  addedBudgets: z
    .array(z.object({ category: z.string().regex(/^[a-z0-9_]{1,32}$/), limitHomeMinor: PositiveAmountMinor }))
    .max(20)
    .optional(),
  /** Monthly take-home pay in the home currency, edited on the review sheet's planner (replaces the main salary). */
  monthlyIncomeMinor: PositiveAmountMinor.optional(),
});
export type OnboardingConfirmOptionsRequest = z.infer<typeof OnboardingConfirmOptionsRequest>;
export const OnboardingConfirmOptionsResponse = z.object({
  core: BaseRulesCore,
  rulesHash: z.string(),
  challengeId: z.string().min(1),
  webauthnOptions: PublicKeyCredentialRequestOptionsJSON,
  draft: OnboardingProfileDraft,
  /** The rent mandate the user is offered next (signed separately via /mandates/options). */
  suggestedMandate: MandateOptionsRequest.nullable(),
  /** Payee names for `suggestedMandate.payeeIds`, for display. */
  suggestedMandatePayees: z.array(z.object({ id: Uuid, name: z.string() })),
  /**
   * The planner's starting point, per month in the home currency: the draft's incomes and its recurring bills,
   * converted at today's rate (shared/plan.ts cadences). Bills here are not budgets: they are paid as bills.
   */
  planBasis: z.object({ monthlyIncomeMinor: AmountMinor, fixedMonthlyMinor: AmountMinor }).optional(),
});
export type OnboardingConfirmOptionsResponse = z.infer<typeof OnboardingConfirmOptionsResponse>;

/** POST /onboarding/confirm */
export const OnboardingConfirmRequest = z.object({
  conversationId: Uuid,
  challengeId: z.string().min(1),
  core: BaseRulesCore,
  assertion: AuthenticationResponseJSON,
});
export type OnboardingConfirmRequest = z.infer<typeof OnboardingConfirmRequest>;
export const OnboardingConfirmResponse = z.object({
  onboarded: z.literal(true),
  /**
   * (added 2026-10-13) The rent mandate offered next, computed after the draft's bills were created (a new user has
   * none at /confirm/options time). Signed separately via /mandates/options; null = nothing to offer.
   */
  suggestedMandate: MandateOptionsRequest.nullable(),
  suggestedMandatePayees: z.array(z.object({ id: Uuid, name: z.string() })),
});
export type OnboardingConfirmResponse = z.infer<typeof OnboardingConfirmResponse>;

// ---------- Handoff (spec §11) ----------

/** GET /handoff/:paymentId */
export const HandoffView = z.object({
  paymentId: Uuid,
  proposalId: Uuid,
  /** Name the supplier / dorm office QR claims. */
  qrPayeeName: z.string(),
  /** Name of the verified payee the order was signed for. */
  verifiedPayeeName: z.string(),
  /** Normalised fuzzy similarity in [0,1]; mismatch below 0.92. */
  nameSimilarity: z.number().min(0).max(1),
  check: z.enum(["MATCH", "QR_PAYEE_MISMATCH"]),
  reasonCodes: z.array(ReasonCode),
  amountMinor: PositiveAmountMinor,
  currency: CurrencyCode,
  qrPayload: z.string(),
  /** Mock QR wallet page ("QR Wallet (simulated)"). Absent on mismatch. */
  walletUrl: z.string().url().nullable(),
  simulated: z.literal(true),
});
export type HandoffView = z.infer<typeof HandoffView>;

// ---------- Pay in place (spec §11) ----------

/** POST /payments/:paymentId/intent - Stripe PaymentIntent (test mode) for the exact order amount. */
export const PayInPlaceIntentResponse = z.object({
  paymentId: Uuid,
  clientSecret: z.string().min(1),
  publishableKey: z.string().min(1),
  amountMinor: PositiveAmountMinor,
  currency: CurrencyCode,
});
export type PayInPlaceIntentResponse = z.infer<typeof PayInPlaceIntentResponse>;

// ---------- Credit record (spec §8, §16) ----------

export const CreditRecordItem = z.enum(["INCOME", "BILLS", "BUDGETS", "PAYMENTS"]);
export type CreditRecordItem = z.infer<typeof CreditRecordItem>;

/** POST /credit-record/export */
export const CreditRecordExportRequest = z.object({
  from: IsoDate,
  to: IsoDate,
  items: z.array(CreditRecordItem).min(1),
});
export type CreditRecordExportRequest = z.infer<typeof CreditRecordExportRequest>;
export const CreditRecordExportResponse = z.object({
  verifyId: z.string().min(1),
  /** Public verify page (`/verify/:id` on the web app). */
  verifyUrl: z.string().url(),
  jsonUrl: z.string().url(),
  pdfUrl: z.string().url(),
  /** base64url SHA-256 of the canonical JSON bundle. */
  sha256: z.string(),
  createdAt: IsoDateTime,
});
export type CreditRecordExportResponse = z.infer<typeof CreditRecordExportResponse>;

/** GET /public/verify/:id (no auth) */
export const CreditRecordVerifyResponse = z.object({
  verifyId: z.string(),
  valid: z.boolean(),
  issuedAt: IsoDateTime,
  /** Bundle version: 1 = before 2026-10-18 (declared income, unclamped period); 2 = evidenced figures only; 3 = credit record key + domain-separated signature, holder name bound, budgets and payments figures (2026-10-19). */
  version: z.number().int().positive().optional(),
  /** The period the figures cover: v2 clamps the request to [account opened, issue day]. */
  period: z.object({ from: IsoDate, to: IsoDate }),
  /** v2: the period the holder asked for (differs from `period` when it was clamped). */
  requestedPeriod: z.object({ from: IsoDate, to: IsoDate }).optional(),
  /** v2: the day the account was opened; nothing before it is covered. */
  accountOpenedOn: IsoDate.optional(),
  /** Initials or masked name only. */
  holder: z.string(),
  /** v3: the bundle binds the holder's full name (keyed hash); KYC = the identity-checked name. */
  holderNameSource: z.enum(["KYC", "PROFILE"]).optional(),
  /** v3, with ?name= : whether that name matches the holder (the name itself is never returned). */
  nameMatch: z.boolean().optional(),
  /** v3: the figures include a simulated history imported when the demo account was set up. */
  importedHistory: z.object({ source: z.literal("seed"), simulated: z.literal(true), openedOn: IsoDate }).optional(),
  items: z.array(CreditRecordItem),
  /** Only the figures of the selected items: BILLS → bills*, INCOME → incomeMonths, BUDGETS → budgets* (v3), PAYMENTS → payments* (v3). */
  summary: z.object({
    monthsCovered: z.number().int().nonnegative(),
    budgetsTotal: z.number().int().nonnegative().optional(),
    budgetsWithinLimit: z.number().int().nonnegative().optional(),
    paymentsCompleted: z.number().int().nonnegative().optional(),
    paymentsOnTimePct: z.number().int().min(0).max(100).optional(),
    billsPaidOnTime: z.number().int().nonnegative().optional(),
    /** Bill periods that fell due in the period. */
    billsTotal: z.number().int().nonnegative().optional(),
    /** Calendar months with incoming money Kassa recorded (money from home, transfers from Kassa users). */
    incomeMonths: z.number().int().nonnegative().optional(),
    /** v1 records only: declared income, not evidence. */
    regularIncomeMonths: z.number().int().nonnegative().optional(),
  }),
  sha256: z.string(),
  keyId: z.string(),
  simulated: z.boolean(),
});
export type CreditRecordVerifyResponse = z.infer<typeof CreditRecordVerifyResponse>;

// ---------- Devices / push ----------

/** POST /devices - register the Expo push token of this app install. */
export const RegisterDeviceRequest = z.object({
  kind: z.literal("APP"),
  expoPushToken: z.string().min(1),
  platform: z.enum(["ios", "android", "web"]),
});
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequest>;

// ---------- Demo (spec §15) ----------

/** Header carrying DEMO_ADMIN_TOKEN on /demo/* calls. */
export const DEMO_TOKEN_HEADER = "x-kassa-demo-token";

export const DemoScenario = z.enum(["settlement", "money-from-home", "landlord-iban-email", "pos-low-dough", "cn-spending-day", "business-forecast"]);
export type DemoScenario = z.infer<typeof DemoScenario>;

/** POST /demo/clock/advance */
export const DemoClockAdvanceRequest = z.object({ hours: z.number().int().positive().max(24 * 31) });
export type DemoClockAdvanceRequest = z.infer<typeof DemoClockAdvanceRequest>;
/** REAL = the system clock (default); DEMO = the demo clock the Stage moves. */
export const ClockMode = z.enum(["REAL", "DEMO"]);
export type ClockMode = z.infer<typeof ClockMode>;
/** POST /demo/clock/mode */
export const DemoClockModeRequest = z.object({ mode: ClockMode });
export type DemoClockModeRequest = z.infer<typeof DemoClockModeRequest>;
export const DemoStateResponse = z.object({
  now: IsoDateTime,
  /** The offset in effect (0 when the clock is REAL). */
  clockOffsetMs: z.number().int(),
  clockMode: ClockMode,
  agentMode: AgentMode,
});
export type DemoStateResponse = z.infer<typeof DemoStateResponse>;

/**
 * POST /demo/cooling (demo deployments only): turn this user's 24 h waits off (passkey, 428 round trip) or back on
 * (no passkey). The waits: a new recipient's cooling period and the delay before a loosening applies.
 */
export const DemoCoolingRequest = z.object({
  enabled: z.boolean(),
  challengeId: z.string().optional(),
  assertion: AuthenticationResponseJSON.optional(),
});
export type DemoCoolingRequest = z.infer<typeof DemoCoolingRequest>;
export const DemoCoolingResponse = z.object({ coolingOn: z.boolean(), offAt: IsoDateTime.nullable() });
export type DemoCoolingResponse = z.infer<typeof DemoCoolingResponse>;

/** POST /demo/agent-mode */
export const DemoAgentModeRequest = z.object({ mode: AgentMode });
export type DemoAgentModeRequest = z.infer<typeof DemoAgentModeRequest>;

/** POST /capture/event sources the notification simulator uses. */
export const SIMULATOR_SOURCE = TransactionSource.enum.NOTIF_SIM;

// ---------- Agent chat stream (AI SDK UI message stream, spec §9) ----------

/**
 * POST /agent/message streams an AI SDK UI message stream. Besides text parts the server emits
 * these data parts (`type: "data-<key>"`) for the inline chat cards, and message metadata.
 * Cards render only these server objects - the order sheet still re-fetches GET /orders/:id (I3).
 */
export const AgentDataParts = {
  proposal: ProposalSummary,
  routes: z.object({
    toCurrency: CurrencyCode,
    amountMinor: PositiveAmountMinor,
    homeCurrency: CurrencyCode,
    routes: z.array(RouteDto),
  }),
  "budget-impact": BudgetImpact,
  choices: DataChoices,
} as const;
export type AgentDataPartTypes = { [K in keyof typeof AgentDataParts]: z.infer<(typeof AgentDataParts)[K]> };

export const AgentMessageMetadata = z.object({
  /** True when the reply was served from a recording (AGENT_MODE=REPLAY): the app shows a "Replay" badge. */
  replay: z.boolean().optional(),
});
export type AgentMessageMetadata = z.infer<typeof AgentMessageMetadata>;

// ---------- Conversations (persisted chats) ----------

/** GET /agent/conversations */
export const ConversationSummary = z.object({
  id: Uuid,
  title: z.string().nullable(),
  createdAt: IsoDateTime,
  /** (added) When the last message was stored (the creation time before the first); the list is newest first by this. */
  lastMessageAt: IsoDateTime.optional(),
  /** (added) Stored messages, user and assistant turns and tool results. */
  messageCount: z.number().int().nonnegative().optional(),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;
/** PATCH /agent/conversations/:id: rename a chat (shown in the history list). */
export const RenameConversationRequest = z.object({ title: z.string().trim().min(1).max(80) });
export type RenameConversationRequest = z.infer<typeof RenameConversationRequest>;
export const ConversationsResponse = z.object({ conversations: z.array(ConversationSummary) });
export type ConversationsResponse = z.infer<typeof ConversationsResponse>;

/** One stored chat message as an AI SDK UIMessage (text + data parts), rehydrated for its owner. */
export const StoredUIMessage = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  parts: z.array(z.looseObject({ type: z.string() })),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type StoredUIMessage = z.infer<typeof StoredUIMessage>;

/** GET /agent/conversations/:id/messages */
export const ConversationMessagesResponse = z.object({ messages: z.array(StoredUIMessage) });
export type ConversationMessagesResponse = z.infer<typeof ConversationMessagesResponse>;

/** GET /onboarding/conversation: the caller's latest onboarding conversation (null when none). */
export const OnboardingConversationResponse = z.object({
  conversationId: Uuid.nullable(),
  draft: OnboardingProfileDraft.nullable(),
  complete: z.boolean(),
  turns: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string(), ui: z.array(DataChoices).default([]) })),
});
export type OnboardingConversationResponse = z.infer<typeof OnboardingConversationResponse>;

// ---------- KassaLite pairing + captures ----------

/** POST /auth/pair/start (full session + passkey, 428 first) → a single-use code, valid 2 minutes. */
export const PairStartRequest = z.object({ challengeId: z.string().optional(), assertion: AuthenticationResponseJSON.optional() });
export type PairStartRequest = z.infer<typeof PairStartRequest>;
export const PairStartResponse = z.object({
  /** 8 characters, unambiguous alphabet; shown with the QR code. */
  code: z.string().length(8),
  expiresAt: IsoDateTime,
  /** QR payload: kassalite://pair?code=…&server=… */
  pairUrl: z.string(),
});
export type PairStartResponse = z.infer<typeof PairStartResponse>;

/** POST /auth/pair/complete (KassaLite, no session) → a device-scoped native session + the Shortcut token. */
export const PairCompleteRequest = z.object({ code: z.string().min(8).max(16), deviceName: z.string().max(60).optional() });
export type PairCompleteRequest = z.infer<typeof PairCompleteRequest>;
export const PairCompleteResponse = AuthSessionResponse.extend({
  /** The iOS Shortcut "Transaction" automation's bearer token (POST /capture/shortcut); shown once. */
  shortcutToken: z.string(),
  deviceId: Uuid,
  /** Stable HTTPS origin the Shortcut and the app should call. */
  serverUrl: z.string(),
});
export type PairCompleteResponse = z.infer<typeof PairCompleteResponse>;

/** GET /capture/recent?since= → the caller's latest captured purchases and nudges (KassaLite Activity). */
export const RecentCapture = z.object({
  id: Uuid,
  source: z.string(),
  merchant: z.string(),
  amountMinor: z.number().int(),
  currency: CurrencyCode,
  homeAmountMinor: z.number().int().nullable(),
  category: z.string().nullable(),
  occurredAt: IsoDateTime,
  createdAt: IsoDateTime,
  /** The likely place ("Blue Bottle Coffee", "café") and where the tap happened ("Váci utca 10, Budapest"), when known. */
  place: z.object({ name: z.string().optional(), kind: z.string().optional(), where: z.string().optional() }).optional(),
});
export type RecentCapture = z.infer<typeof RecentCapture>;
export const RecentCapturesResponse = z.object({
  captures: z.array(RecentCapture),
  nudges: z.array(z.object({ id: Uuid, title: z.string(), body: z.string(), createdAt: IsoDateTime })),
  serverTime: IsoDateTime,
});
export type RecentCapturesResponse = z.infer<typeof RecentCapturesResponse>;

// ---------- Savings plan (the "your rules" planner) ----------

/**
 * POST /plan/advice: income, fixed bills and budgets per month plus a savings goal. The server works out what is left
 * each month and, when the goal does not fit, suggests lower limits for the flexible budgets (AI-written when the
 * user allows AI processing, else a deterministic rule). Advice only: nothing is changed until the user applies it.
 */
export const PlanAdviceRequest = z.object({
  currency: CurrencyCode,
  monthlyIncomeMinor: AmountMinor,
  fixedMonthlyMinor: AmountMinor,
  budgets: z
    .array(z.object({ category: z.string().regex(/^[a-z0-9_]{1,32}$/), limitHomeMinor: PositiveAmountMinor }))
    .max(20),
  goal: z.object({ amountMinor: PositiveAmountMinor, months: z.number().int().min(1).max(60) }),
});
export type PlanAdviceRequest = z.infer<typeof PlanAdviceRequest>;
export const PlanAdviceResponse = z.object({
  source: z.enum(["AI", "RULES"]),
  /** One or two plain sentences for the user. */
  summary: z.string(),
  /** Suggested limits (only the categories that change); empty when the goal already fits. */
  budgets: z.array(z.object({ category: z.string(), limitHomeMinor: PositiveAmountMinor })),
  /** Left each month after bills and budgets, with the suggestion applied (may be negative). */
  monthlyLeftMinor: z.number().int(),
  /** monthlyLeftMinor × months (0 when negative). */
  projectedMinor: AmountMinor,
  /** Months the goal takes at that pace; null when nothing is left to save. */
  monthsToGoal: z.number().int().positive().nullable(),
});
export type PlanAdviceResponse = z.infer<typeof PlanAdviceResponse>;

// ---------- Wallet: test top-ups and Kassa-to-Kassa ----------

/** How a test top-up is "paid": a wallet tap (simulated sheet in the app) or a test card. */
export const TopUpMethod = z.enum(["APPLE_PAY", "GOOGLE_PAY", "SAMSUNG_PAY", "CARD", "LINKED"]);
export type TopUpMethod = z.infer<typeof TopUpMethod>;

/** GET /wallet: the user's Kassa ID (what another user types to pay them) and how top-ups run here. */
export const WalletResponse = z.object({
  /** "KSA-7QMX-2HVA": a public handle, safe to share. */
  kassaId: z.string(),
  /** Top-ups need the capped wallet (money mode CAPPED_WALLET). */
  canTopUp: z.boolean(),
  /** "stripe-test": a Stripe test-mode PaymentIntent is charged; "simulated": no card network at all. */
  topUpProvider: z.enum(["stripe-test", "simulated"]),
  /** What one day of top-ups may add, in the home currency (the user's signed per-day cap). */
  topUpDailyLimitHomeMinor: AmountMinor,
  topUpTodayHomeMinor: AmountMinor,
  homeCurrency: CurrencyCode,
  currencies: z.array(CurrencyCode),
});
export type WalletResponse = z.infer<typeof WalletResponse>;

/** POST /wallet/top-ups: add test money to the wallet. Never real money: Stripe test mode or a simulation. */
export const TopUpRequest = z.object({
  amountMinor: PositiveAmountMinor,
  currency: CurrencyCode,
  method: TopUpMethod,
  /** (added 2026-10-16) method LINKED: the linked card or bank account to pull from (in `currency`). */
  fundingSourceId: Uuid.optional(),
  /** One top-up per key (a double tap or a retry after a timeout adds the money once). */
  idempotencyKey: z.string().uuid(),
});
export type TopUpRequest = z.infer<typeof TopUpRequest>;
export const TopUpResponse = z.object({
  topUpId: z.string(),
  amountMinor: PositiveAmountMinor,
  currency: CurrencyCode,
  method: TopUpMethod,
  provider: z.enum(["stripe-test", "simulated"]),
  /** Stripe PaymentIntent id (pi_…) or a simulated reference. */
  providerRef: z.string(),
  balanceAfterMinor: AmountMinor.nullable(),
  simulated: z.literal(true),
});
export type TopUpResponse = z.infer<typeof TopUpResponse>;

/**
 * POST /payees/:id/pay: the user asks to pay one of their payees (any scheme, another Kassa user included). It goes
 * through the same rules as an agent draft and comes back as a proposal to approve with the passkey.
 */
export const PayPayeeRequest = z.object({
  amountMinor: PositiveAmountMinor,
  currency: CurrencyCode,
  purpose: z.string().trim().min(1).max(140),
  /** (added 2026-10-16) pay from this linked card or bank instead of the wallet; signed into the order. */
  fundingSourceId: Uuid.optional(),
});
export type PayPayeeRequest = z.infer<typeof PayPayeeRequest>;
export const PayPayeeResponse = z.object({
  proposalId: z.string().uuid(),
  decision: z.string(),
  reasonCodes: z.array(z.string()),
  summary: z.string(),
  /** (added 2026-10-16) an AUTO send (mandate or small-auto) ran right away: its payment status and delivery time. */
  paymentStatus: z.string().nullable().optional(),
  deliveredInMs: z.number().int().nonnegative().optional(),
});
export type PayPayeeResponse = z.infer<typeof PayPayeeResponse>;

/**
 * (added 2026-10-18) POST /conversions: exchange between the user's own wallet balances. Buys `amountMinor` of
 * `toCurrency` from `fromCurrency` (omitted: the cheapest balance that covers it, route optimizer). It comes back as a
 * CONVERT order to sign with the passkey (always ASK); the response has the PayPayeeResponse shape.
 */
export const ConvertRequest = z
  .object({
    toCurrency: CurrencyCode,
    amountMinor: PositiveAmountMinor,
    fromCurrency: CurrencyCode.optional(),
  })
  .refine((r) => r.fromCurrency !== r.toCurrency, { message: "fromCurrency and toCurrency must differ", path: ["fromCurrency"] });
export type ConvertRequest = z.infer<typeof ConvertRequest>;
