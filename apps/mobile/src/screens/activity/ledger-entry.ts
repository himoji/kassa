/**
 * Read the display fields out of a ledger entry payload. The payload shape belongs to each
 * writer module (A), so this only picks well-known optional keys and validates them with the
 * shared schemas - anything else is ignored rather than guessed.
 */
import { Decision, ReasonCode, type LedgerEntryDto } from "@kassa/shared";
import { z } from "zod";

const Shape = z
  .object({
    amountMinor: z.number().int().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    payeeName: z.string().optional(),
    merchant: z.string().optional(),
    decision: Decision.optional(),
    reasonCodes: z.array(z.string()).optional(),
    proposalId: z.string().optional(),
    paymentId: z.string().optional(),
    status: z.string().optional(),
  })
  .partial();

export interface LedgerDisplay {
  amount: { amountMinor: number; currency: string } | null;
  counterparty: string | null;
  decision: Decision | null;
  reasonCodes: ReasonCode[];
  refused: boolean;
  proposalId: string | null;
  paymentId: string | null;
}

export function ledgerDisplay(entry: LedgerEntryDto): LedgerDisplay {
  const parsed = Shape.safeParse(entry.payload);
  const p = parsed.success ? parsed.data : {};
  const reasonCodes = (p.reasonCodes ?? []).flatMap((c) => {
    const r = ReasonCode.safeParse(c);
    return r.success ? [r.data] : [];
  });
  return {
    amount:
      p.amountMinor !== undefined && p.currency
        ? { amountMinor: p.amountMinor, currency: p.currency }
        : null,
    counterparty: p.payeeName ?? p.merchant ?? null,
    decision: p.decision ?? null,
    reasonCodes,
    refused: p.decision === "REFUSE" || /REFUS|REJECT|DECLIN/.test(entry.type),
    proposalId: p.proposalId ?? null,
    paymentId: p.paymentId ?? null,
  };
}
