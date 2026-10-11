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
  payeeRef: PlaceholderRef.describe("Payee placeholder from get_obligations / get_payee_facts"),
  amountMinor: AmountMinor,
  currency: Currency,
  purpose: z.string().min(1).max(140),
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
