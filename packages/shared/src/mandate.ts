import { z } from "zod";

import { MandatePeriod } from "./enums.ts";
import { jcsHash } from "./jcs.ts";

function isSortedUnique(values: readonly string[]): boolean {
  for (let i = 1; i < values.length; i++) if (!(values[i - 1]! < values[i]!)) return false;
  return true;
}

/**
 * The passkey-signed part of a mandate (spec §6 mandates, §7 T1). `mandateHash = sha256(JCS(core))`
 * is the WebAuthn challenge when the user creates it. Arrays must be sorted and unique so a mandate
 * has exactly one canonical encoding; build it with `normalizeMandateCore`.
 */
export const MandateCore = z
  .object({
    v: z.literal(1),
    mandateId: z.string().uuid(),
    userId: z.string().uuid(),
    payeeIds: z.array(z.string().uuid()).min(1),
    categories: z.array(z.string().min(1)).min(1),
    currency: z.string().length(3),
    maxPerPaymentMinor: z.number().int().positive(),
    maxPerPeriodMinor: z.number().int().positive(),
    period: MandatePeriod,
    validFrom: z.string().datetime(),
    validUntil: z.string().datetime().nullable(),
  })
  .superRefine((m, ctx) => {
    if (!isSortedUnique(m.payeeIds)) {
      ctx.addIssue({ code: "custom", path: ["payeeIds"], message: "must be sorted and unique" });
    }
    if (!isSortedUnique(m.categories)) {
      ctx.addIssue({ code: "custom", path: ["categories"], message: "must be sorted and unique" });
    }
    if (m.maxPerPaymentMinor > m.maxPerPeriodMinor) {
      ctx.addIssue({
        code: "custom",
        path: ["maxPerPaymentMinor"],
        message: "must not exceed maxPerPeriodMinor",
      });
    }
    if (m.validUntil !== null && Date.parse(m.validUntil) <= Date.parse(m.validFrom)) {
      ctx.addIssue({ code: "custom", path: ["validUntil"], message: "must be after validFrom" });
    }
  });
export type MandateCore = z.infer<typeof MandateCore>;

/** Sort + dedupe the arrays, then validate. */
export function normalizeMandateCore(input: MandateCore): MandateCore {
  return MandateCore.parse({
    ...input,
    payeeIds: [...new Set(input.payeeIds)].sort(),
    categories: [...new Set(input.categories)].sort(),
  });
}

/** mandateHash = base64url(sha256(utf8(JCS(mandateCore)))). Parses first, like `orderHash`. */
export function mandateHash(core: MandateCore): string {
  return jcsHash(MandateCore.parse(core));
}
