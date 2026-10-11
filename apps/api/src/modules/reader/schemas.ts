import { z } from "zod";

import type { FieldCheck, ReaderDocType, ReaderField, ReasonCode } from "@kassa/shared";

/*
 * Reader structured outputs (spec §9 "Reader (I10)"). Every field carries `evidence`: an exact substring
 * copied from the source. The model's output is never trusted: the server re-checks each field
 * (reader/evidence.ts) and marks it VERIFIED / UNVERIFIED.
 */

const Field = (desc: string) =>
  z
    .object({
      value: z.string().nullable().describe(desc),
      evidence: z.string().nullable().describe("Exact substring copied character-for-character from the source that contains the value; null if absent"),
    })
    .describe(desc);

export const InvoiceExtraction = z.object({
  payeeName: Field("Who is to be paid (the creditor), as printed"),
  accountNumber: Field("Creditor account (IBAN or account number) as printed"),
  reference: Field("Payment reference / invoice number"),
  amount: Field("Total amount due as a plain decimal with a dot, no thousands separators, e.g. 2400.00"),
  currency: Field("ISO 4217 code of the amount, e.g. EUR"),
  dueDate: Field("Due date as YYYY-MM-DD"),
});

export const NotificationExtraction = z.object({
  merchant: Field("Merchant name as printed"),
  amount: Field("Amount as a plain decimal with a dot, no thousands separators"),
  currency: Field("ISO 4217 code of the amount"),
  cardHint: Field("Card hint such as last 4 digits, if present"),
  time: Field("Time of the purchase as printed (HH:MM or full date-time)"),
});

export const EmailChangeRequestExtraction = z.object({
  claimedPayee: Field("Who the email claims to be"),
  newAccount: Field("The new account / IBAN the email asks to use"),
  urgencyCues: z
    .array(z.object({ value: z.string(), evidence: z.string() }))
    .describe("Phrases that pressure the reader to act quickly, each with its exact evidence"),
});

export const EXTRACTION_SCHEMAS = {
  invoice: InvoiceExtraction,
  notification: NotificationExtraction,
  email_change_request: EmailChangeRequestExtraction,
} as const;

export type Extraction<K extends ReaderDocType> = z.infer<(typeof EXTRACTION_SCHEMAS)[K]>;

/** Model output when the source is an image: the transcription is what evidence is checked against. */
export const withTranscript = <S extends z.ZodObject>(schema: S) =>
  z.object({
    transcript: z.string().describe("Verbatim transcription of all text visible in the image"),
    fields: schema,
  });

/** Critical fields per document type: an UNVERIFIED critical field yields READER_SOURCE_MISMATCH (§9). */
export const CRITICAL_FIELDS: Record<ReaderDocType, { amount: string | null; account: string | null }> = {
  invoice: { amount: "amount", account: "accountNumber" },
  notification: { amount: "amount", account: null },
  email_change_request: { amount: null, account: "newAccount" },
};

export interface ReaderChecks {
  amount?: FieldCheck;
  account?: FieldCheck;
  nonCriticalUnverified: boolean;
  fields: Record<string, FieldCheck>;
  /** Field → why it failed (e.g. "evidence not found in source", "number differs from evidence"). */
  failures: Record<string, string>;
}

export interface ReaderResult {
  kind: ReaderDocType;
  fields: Record<string, ReaderField>;
  /** Server-parsed values (only from VERIFIED fields). */
  parsed: {
    amountMinor?: number;
    currency?: string;
    dueDate?: string;
    account?: string;
  };
  urgencyCues?: string[];
  checks: ReaderChecks;
  reasonCodes: ReasonCode[];
  sourceKind: "text" | "pdf" | "image";
  /** Model id that produced the extraction (provider:model) or "replay". */
  model: string;
}
