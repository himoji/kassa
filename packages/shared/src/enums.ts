import { z } from "zod";

// Enums from spec §6 (data model), §7 (rails), §10 (decisions). Each is a zod enum plus a type of the
// same name; use `X.enum.VALUE` or `X.options` for the runtime values.

export const Region = z.enum(["EU", "CN"]);
export type Region = z.infer<typeof Region>;

export const Preset = z.enum(["ASK_ME", "SMART", "AUTOPILOT"]);
export type Preset = z.infer<typeof Preset>;

export const MoneyMode = z.enum(["PAY_IN_PLACE", "CAPPED_WALLET", "HANDOFF"]);
export type MoneyMode = z.infer<typeof MoneyMode>;

export const NotificationMode = z.enum(["EACH", "THRESHOLDS", "DIGEST"]);
export type NotificationMode = z.infer<typeof NotificationMode>;

/** Advanced switch "Agent" from the preset table (build plan): acts only when asked / plans ahead / plans and acts. */
export const AgentAutonomy = z.enum(["ON_REQUEST", "PLAN_AHEAD", "PLAN_AND_ACT"]);
export type AgentAutonomy = z.infer<typeof AgentAutonomy>;

/** Advanced switch "Payments": always ask / ask when risky / never ask inside a signed mandate. */
export const PaymentPolicy = z.enum(["ALWAYS_ASK", "RISK_BASED", "NEVER_ASK"]);
export type PaymentPolicy = z.infer<typeof PaymentPolicy>;

export const PayeeKind = z.enum([
  "LANDLORD",
  "UNIVERSITY",
  "INSURER",
  "MERCHANT",
  "SUPPLIER",
  "PERSON",
  "OWN_ACCOUNT",
  // (added, migration 0013) utilities, phone, internet: the Bills recipient category (shared/recipient.ts)
  "BILLER",
]);
export type PayeeKind = z.infer<typeof PayeeKind>;

export const PayeeStatus = z.enum(["VERIFIED", "COOLING", "BLOCKED"]);
export type PayeeStatus = z.infer<typeof PayeeStatus>;

export const Recurrence = z.enum(["MONTHLY", "ONCE", "TERM"]);
export type Recurrence = z.infer<typeof Recurrence>;

export const IncomeCadence = z.enum(["WEEKLY", "MONTHLY", "TERM", "ONCE"]);
export type IncomeCadence = z.infer<typeof IncomeCadence>;

export const CardKind = z.enum(["HOME_KZT", "USD", "LOCAL_HUF", "MULTI"]);
export type CardKind = z.infer<typeof CardKind>;

export const TransactionSource = z.enum([
  "SHORTCUT",
  "NOTIF_SIM",
  "TEXT",
  "VOICE",
  "SCREENSHOT",
  "SETTLEMENT",
  "KASSA_PAYMENT",
  // (added, migration 0010) rows from a data import (POST /import/commit)
  "IMPORT",
]);
export type TransactionSource = z.infer<typeof TransactionSource>;

export const TransactionStatus = z.enum(["PENDING", "SETTLED"]);
export type TransactionStatus = z.infer<typeof TransactionStatus>;

export const MandatePeriod = z.enum(["WEEK", "MONTH"]);
export type MandatePeriod = z.infer<typeof MandatePeriod>;

export const MandateStatus = z.enum(["ACTIVE", "PENDING_EFFECTIVE", "REVOKED"]);
export type MandateStatus = z.infer<typeof MandateStatus>;

export const RuleChangeDirection = z.enum(["LOOSEN", "TIGHTEN"]);
export type RuleChangeDirection = z.infer<typeof RuleChangeDirection>;

export const ProposalCreatedBy = z.enum(["AGENT", "SCHEDULER", "USER"]);
export type ProposalCreatedBy = z.infer<typeof ProposalCreatedBy>;

/** Lifecycle of a proposal row. Not enumerated in the spec; this is the contract the API and app share. */
export const ProposalStatus = z.enum([
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "REFUSED",
  "HANDOFF",
  "EXECUTED",
  "EXPIRED",
  "FAILED",
]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

/** Rules decision (spec §5, §10). */
export const Decision = z.enum(["AUTO", "ASK", "HANDOFF", "REFUSE"]);
export type Decision = z.infer<typeof Decision>;

/** T1 = auto inside a passkey-signed mandate; T2 = passkey per order. */
export const Tier = z.enum(["T1", "T2"]);
export type Tier = z.infer<typeof Tier>;

export const Rail = z.enum(["CARD_ISSUING", "BANK_TRANSFER", "HANDOFF", "PAY_IN_PLACE"]);
export type Rail = z.infer<typeof Rail>;

export const PaymentStatus = z.enum(["CREATED", "PROCESSING", "SENT", "FAILED", "CANCELED"]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

export const DeviceKind = z.enum(["IOS_SHORTCUT", "APP"]);
export type DeviceKind = z.infer<typeof DeviceKind>;

/** Demo agent mode (`demo_state.agentMode`, `AGENT_MODE`). */
export const AgentMode = z.enum(["LIVE", "REPLAY"]);
export type AgentMode = z.infer<typeof AgentMode>;

export const IssuingProvider = z.enum(["stripe", "fake"]);
export type IssuingProvider = z.infer<typeof IssuingProvider>;

/** Reader document types (spec §9). */
export const ReaderDocType = z.enum(["invoice", "notification", "email_change_request"]);
export type ReaderDocType = z.infer<typeof ReaderDocType>;

/** Reader per-field verification against the source text (spec §9, I10). */
export const FieldCheck = z.enum(["VERIFIED", "UNVERIFIED"]);
export type FieldCheck = z.infer<typeof FieldCheck>;

/** Budget pace (spec §13): on track or ahead of pace; OVER once the limit is spent. */
export const BudgetPace = z.enum(["ON_TRACK", "AHEAD_OF_PACE", "OVER"]);
export type BudgetPace = z.infer<typeof BudgetPace>;
