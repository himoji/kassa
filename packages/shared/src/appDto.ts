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
 * Additive only - see docs/spec/PHASE1_COORDINATION.md "Contract changes" for the endpoint list.
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

/** POST /onboarding/message */
export const OnboardingMessageRequest = z.object({
  conversationId: Uuid,
  text: z.string().min(1).max(4000),
});
export type OnboardingMessageRequest = z.infer<typeof OnboardingMessageRequest>;
export const OnboardingMessageResponse = z.object({
  reply: z.string(),
  draft: OnboardingProfileDraft,
  /** True once the draft has everything needed for the review screen. */
  complete: z.boolean(),
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
export const OnboardingConfirmOptionsRequest = z.object({ conversationId: Uuid });
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
export const OnboardingConfirmResponse = z.object({ onboarded: z.literal(true) });
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
  period: z.object({ from: IsoDate, to: IsoDate }),
  /** Initials or masked name only. */
  holder: z.string(),
  items: z.array(CreditRecordItem),
  summary: z.object({
    billsPaidOnTime: z.number().int().nonnegative(),
    billsTotal: z.number().int().nonnegative(),
    monthsCovered: z.number().int().nonnegative(),
    regularIncomeMonths: z.number().int().nonnegative(),
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

export const DemoScenario = z.enum(["settlement", "money-from-home", "landlord-iban-email", "pos-low-dough", "cn-spending-day"]);
export type DemoScenario = z.infer<typeof DemoScenario>;

/** POST /demo/clock/advance */
export const DemoClockAdvanceRequest = z.object({ hours: z.number().int().positive().max(24 * 31) });
export type DemoClockAdvanceRequest = z.infer<typeof DemoClockAdvanceRequest>;
export const DemoStateResponse = z.object({
  now: IsoDateTime,
  clockOffsetMs: z.number().int(),
  agentMode: AgentMode,
});
export type DemoStateResponse = z.infer<typeof DemoStateResponse>;

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
} as const;
export type AgentDataPartTypes = { [K in keyof typeof AgentDataParts]: z.infer<(typeof AgentDataParts)[K]> };

export const AgentMessageMetadata = z.object({
  /** True when the reply was served from a recording (AGENT_MODE=REPLAY): the app shows a "Replay" badge. */
  replay: z.boolean().optional(),
});
export type AgentMessageMetadata = z.infer<typeof AgentMessageMetadata>;
