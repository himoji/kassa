import { z } from "zod";

import { Decision, Rail } from "./enums.ts";
import { ReasonCode } from "./reasonCodes.ts";

/*
 * Planner tool input schemas (spec §9). `propose_order` is the agent's only write tool (I1).
 * References like `payee_3` are redaction placeholders (I11) resolved server-side.
 */

const Currency = z.string().regex(/^[A-Z]{3}$/).describe("ISO 4217 code, e.g. EUR");
const AmountMinor = z.number().int().positive().describe("Integer minor units (cents), never a float");
const PlaceholderRef = z.string().min(1).max(64);

export const GetProfileSummaryInput = z.object({});
export const GetBalancesInput = z.object({});
export const GetBudgetInput = z.object({
  category: z.string().min(1).max(64).optional().describe("Budget category; omit for all"),
});
export const GetObligationsInput = z.object({
  withinDays: z.number().int().min(1).max(365).optional().describe("Only bills due within this many days"),
});
export const GetPayeeFactsInput = z.object({
  payeeRef: PlaceholderRef.describe("Payee placeholder, e.g. payee_3"),
});
export const SearchCatalogInput = z.object({
  merchant: z.string().min(1).max(64).describe("Merchant or supplier id"),
  query: z.string().min(1).max(200),
});
export const GetRoutesInput = z.object({
  fromCurrency: Currency,
  toCurrency: Currency,
  amountMinor: AmountMinor.describe("Bill amount in toCurrency minor units"),
  dueDate: z.iso.date().optional().describe("YYYY-MM-DD"),
});
export const ForecastCoverageInput = z.object({});
export const GetSpendingSummaryInput = z.object({});
export const GetMoneyHistoryInput = z.object({});
export const ReadDocumentInput = z.object({
  docId: z.string().min(1).max(64),
});
export const OrderItem = z.object({
  sku: z.string().max(64).optional(),
  name: z.string().min(1).max(140),
  quantity: z.number().int().positive(),
  unitPriceMinor: z.number().int().nonnegative(),
});
export type OrderItem = z.infer<typeof OrderItem>;
export const ProposeOrderInput = z.object({
  // (2026-10-18) optional only for kind CONVERT; a payment without it is answered with an error.
  payeeRef: PlaceholderRef.optional().describe("Payee placeholder from get_obligations / get_payee_facts (required to pay; omit for CONVERT)"),
  amountMinor: AmountMinor,
  currency: Currency,
  purpose: z.string().min(1).max(140),
  // (added 2026-10-18) CONVERT = exchange between the user's own balances (never a payment out; always the passkey).
  kind: z
    .enum(["PAY", "CONVERT"])
    .optional()
    .describe("PAY (default) pays payeeRef. CONVERT buys amountMinor of currency from the user's own fromCurrency balance (no payee); use it when no single balance covers a bill, then pay the bill"),
  fromCurrency: Currency.optional().describe("CONVERT only: the balance to convert from; omitted = the cheapest balance that covers it"),
  rail: Rail.optional(),
  items: z.array(OrderItem).max(50).optional(),
  agentRequestedConfirm: z
    .boolean()
    .optional()
    .describe("Set true if unsure; forces ASK, never AUTO"),
  // (added 2026-10-11, B1) explicit source documents; their persisted Reader checks always reach the rules (I10).
  docIds: z
    .array(z.string().uuid())
    .max(10)
    .optional()
    .describe("docId of every document (invoice) this payment is based on, from read_document"),
});
export const LogExpenseInput = z.object({
  text: z.string().min(1).max(1000).describe("Free-text expense, e.g. 'coffee 1200 HUF'"),
});

/*
 * (added 2026-10-15, Business M5) The business tool set, only for a BUSINESS account. propose_purchase_order writes
 * a DRAFT purchase order and nothing else: it never creates a payment or an approval (the owner signs the PO with
 * the payments passkey; the supplier's invoice is paid later through propose_order's rules path).
 */
export const GetInventoryInput = z.object({});
export const ForecastStockInput = z.object({});
export const ProposePurchaseOrderInput = z.object({
  supplierRef: PlaceholderRef.describe("Supplier payee placeholder from forecast_stock (supplierRef), e.g. payee_1"),
  lines: z
    .array(
      z.object({
        supplierSku: z.string().min(1).max(64).describe("Supplier catalog SKU, e.g. BOX-33CM-100"),
        packs: z.number().int().positive().max(1000).describe("Whole packs"),
      }),
    )
    .min(1)
    .max(20),
});

/*
 * (added 2026-10-13) Read-only FX lookup. Not a write tool: never counts toward proposal gating.
 */
export const GetFxRateInput = z.object({
  from: Currency,
  to: Currency,
  amountMinor: AmountMinor.optional().describe("Amount in `from` minor units to convert; omit for the rate only"),
  date: z.iso.date().optional().describe("YYYY-MM-DD rate date; omit for today"),
});

/*
 * (added 2026-10-19) Read-only: the user's recent orders and payments with their status, so the planner checks what is
 * paid before calling a bill unpaid. Never part of proposal gating.
 */
export const GetPaymentsInput = z.object({
  limit: z.number().int().min(1).max(20).optional().describe("How many recent orders, newest first (default 10)"),
});

/** Read-only tools on top of the spec's eleven (apps/api agent/tools.ts READ_TOOLS). */
export const READ_TOOL_INPUT_SCHEMAS = {
  get_fx_rate: GetFxRateInput,
  get_spending_summary: GetSpendingSummaryInput,
  get_money_history: GetMoneyHistoryInput,
  get_payments: GetPaymentsInput,
} as const;
export type ReadToolName = keyof typeof READ_TOOL_INPUT_SCHEMAS;

/*
 * (added 2026-10-13) UI tools: each emits a `data-choices` part and ends the turn, so the app waits for the user's
 * pick (tap or, later, speech). The server validates the answer against the stored part.
 */
const ChoiceOptionInput = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,32}$/).describe("Stable option id, e.g. eur"),
  label: z.string().min(1).max(60).describe("What the button says"),
  spoken: z.array(z.string().min(1).max(60)).max(6).optional().describe("Synonyms a user may say or type, e.g. ['euro', 'euros']"),
  value: z.string().max(120).optional().describe("Machine value; defaults to id"),
});
export const AskChoiceInput = z.object({
  prompt: z.string().min(1).max(200),
  options: z.array(ChoiceOptionInput).min(2).max(8),
  multi: z.boolean().optional(),
  allowOther: z.boolean().optional().describe("Let the user type something else"),
});
export const AskAmountInput = z.object({
  prompt: z.string().min(1).max(200),
  currency: Currency,
  defaultMinor: AmountMinor.optional(),
  minMinor: z.number().int().nonnegative().optional(),
  maxMinor: AmountMinor.optional(),
  stepMinor: AmountMinor.optional(),
});
export const AskBudgetsInput = z.object({
  prompt: z.string().min(1).max(200),
  currency: Currency.describe("The user's home currency"),
  items: z
    .array(
      z.object({
        category: z.string().regex(/^[a-z0-9_]{1,32}$/).describe("Budget category, e.g. groceries, eating_out, transport"),
        label: z.string().min(1).max(60),
        emoji: z.string().max(16).optional().describe("One emoji for the category"),
        amountMinor: AmountMinor.describe("Suggested monthly limit, home currency minor units"),
      }),
    )
    .min(1)
    .max(12),
});
export const AskDateInput = z.object({
  prompt: z.string().min(1).max(200),
  min: z.iso.date().optional(),
  max: z.iso.date().optional(),
  default: z.iso.date().optional(),
});
export const AskConfirmInput = z.object({
  prompt: z.string().min(1).max(200),
  yesLabel: z.string().min(1).max(30).optional(),
  noLabel: z.string().min(1).max(30).optional(),
});

export const UI_TOOL_INPUT_SCHEMAS = {
  ask_choice: AskChoiceInput,
  ask_amount: AskAmountInput,
  ask_budgets: AskBudgetsInput,
  ask_date: AskDateInput,
  ask_confirm: AskConfirmInput,
} as const;
export type UiToolName = keyof typeof UI_TOOL_INPUT_SCHEMAS;

export const BUSINESS_TOOL_INPUT_SCHEMAS = {
  get_inventory: GetInventoryInput,
  forecast_stock: ForecastStockInput,
  propose_purchase_order: ProposePurchaseOrderInput,
} as const;
export type BusinessToolName = keyof typeof BUSINESS_TOOL_INPUT_SCHEMAS;

export const TOOL_INPUT_SCHEMAS = {
  get_profile_summary: GetProfileSummaryInput,
  get_balances: GetBalancesInput,
  get_budget: GetBudgetInput,
  get_obligations: GetObligationsInput,
  get_payee_facts: GetPayeeFactsInput,
  search_catalog: SearchCatalogInput,
  get_routes: GetRoutesInput,
  forecast_coverage: ForecastCoverageInput,
  read_document: ReadDocumentInput,
  propose_order: ProposeOrderInput,
  log_expense: LogExpenseInput,
} as const;

export const ToolName = z.enum(
  Object.keys(TOOL_INPUT_SCHEMAS) as [keyof typeof TOOL_INPUT_SCHEMAS, ...(keyof typeof TOOL_INPUT_SCHEMAS)[]],
);
export type ToolName = z.infer<typeof ToolName>;
export type ToolInput<N extends ToolName> = z.infer<(typeof TOOL_INPUT_SCHEMAS)[N]>;

/** `propose_order` result (spec §9). Also the agent chat "proposal card". */
export const ProposeOrderResult = z.object({
  proposalId: z.string().uuid(),
  decision: Decision,
  reasonCodes: z.array(ReasonCode),
  riskScore: z.number().min(0).max(1),
  summary: z.string(),
});
export type ProposeOrderResult = z.infer<typeof ProposeOrderResult>;
