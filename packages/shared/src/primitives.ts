import { z } from "zod";

/** RFC 9562 UUID string. */
export const Uuid = z.string().uuid();

/** ISO 4217 alpha code, upper case (e.g. `KZT`). */
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 currency code");
export type CurrencyCode = z.infer<typeof CurrencyCode>;

/** Integer minor units. Never floats for money (spec §0). */
export const AmountMinor = z.number().int().refine(Number.isSafeInteger, "safe integer");
export const PositiveAmountMinor = AmountMinor.refine((n) => n > 0, "positive");

/** ISO 8601 UTC timestamp (`2026-10-10T12:00:00.000Z`). */
export const IsoDateTime = z.string().datetime();
/** Calendar date `YYYY-MM-DD`. */
export const IsoDate = z.iso.date();

/** Opaque pagination cursor; `null` when there is no next page. */
export const Cursor = z.string().min(1);

export function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: Cursor.nullable(),
  });
}
