/*
 * (added 2026-10-16) The KYC threshold in a user's home currency: KYC_THRESHOLD_MINOR is a fixed amount in
 * KYC_THRESHOLD_CURRENCY (default EUR 1,000.00), converted and rounded down, like the payments daily cap. When it
 * cannot be converted the threshold is 0: every payment and top-up then needs a VERIFIED check (fail closed).
 * Payments does not use this: it converts with its own fx port (payments/index.ts).
 */
import { env } from "../../env.ts";
import { toHome } from "../money/fx.ts";

export async function kycThresholdInHome(homeCurrency: string, at: Date): Promise<number> {
  const e = env();
  if (e.KYC_THRESHOLD_CURRENCY === homeCurrency) return e.KYC_THRESHOLD_MINOR;
  try {
    const v = (await toHome(e.KYC_THRESHOLD_MINOR, e.KYC_THRESHOLD_CURRENCY, homeCurrency, at, "down")).amountMinor;
    return Number.isSafeInteger(v) && v >= 0 ? v : 0;
  } catch {
    return 0;
  }
}
