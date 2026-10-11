import { applyBps, cmp, convertMinor, div, fromInt, mul, rat, roundHalfUp, sub, toSafeNumber, type Rational } from "./rational.ts";
import { medianInt } from "./forecast.ts";

/*
 * Fee x-ray (spec §12):
 *   feeHome   = settledHome − amountOriginal × mid(date)          (in home minor units)
 *   markupBps = feeHome / (amountOriginal × mid) × 10000
 * card_fee_profiles keep a rolling median of markupBps (last ROLLING_WINDOW settled samples).
 * Best card = argmin_c(markupBps_c × amount + fixed_c).
 * DCC flag: purchase abroad but charged in the home currency, charge > mid by more than 2 %.
 */

export const ROLLING_WINDOW = 20;
export const DCC_THRESHOLD_BPS = 200;

export interface SettlementInput {
  amountOriginalMinor: number;
  originalCurrency: string;
  settledAmountMinor: number;
  settledCurrency: string;
  homeCurrency: string;
  /** mid(original → home) on the purchase date. */
  midOrigToHome: Rational;
  /** mid(settled → home); required when settledCurrency ≠ homeCurrency. */
  midSettledToHome?: Rational;
}

export interface SettlementFee {
  midHomeMinor: number;
  settledHomeMinor: number;
  feeHomeMinor: number;
  markupBps: number;
}

export function settlementFee(i: SettlementInput): SettlementFee {
  const midHomeMinor = convertMinor(i.amountOriginalMinor, i.originalCurrency, i.homeCurrency, i.midOrigToHome);
  let settledHomeMinor: number;
  if (i.settledCurrency === i.homeCurrency) settledHomeMinor = i.settledAmountMinor;
  else {
    if (!i.midSettledToHome) throw new RangeError("settlementFee: midSettledToHome required");
    settledHomeMinor = convertMinor(i.settledAmountMinor, i.settledCurrency, i.homeCurrency, i.midSettledToHome);
  }
  const feeHomeMinor = settledHomeMinor - midHomeMinor;
  const markupBps = midHomeMinor === 0 ? 0 : toSafeNumber(roundHalfUp(div(mul(fromInt(feeHomeMinor), rat(10000n)), fromInt(midHomeMinor))));
  return { midHomeMinor, settledHomeMinor, feeHomeMinor, markupBps };
}

/** Rolling median over the most recent samples (input ordered oldest → newest). */
export function rollingMedianBps(samplesOldestFirst: number[], window = ROLLING_WINDOW): number {
  return medianInt(samplesOldestFirst.slice(-window));
}

export interface CardFeeProfile {
  cardId: string;
  fromCurrency: string;
  toCurrency: string;
  medianMarkupBps: number;
  /** Fixed fee per transaction in the card's billing (toCurrency) minor units. */
  fixedFeeMinor: number;
}

/**
 * Best card for spending `amountMinor` of `currency`: argmin(markupBps × amount / 10000 + fixed).
 * Costs are compared in home currency when `toHome` is given (cards bill in different currencies);
 * otherwise in the card's billing minor units. A card billed in `currency` itself has zero markup.
 */
export function bestCard(
  amountMinor: number,
  currency: string,
  profiles: CardFeeProfile[],
  cards: Array<{ id: string; billingCurrency: string }>,
  toHome: (amountMinor: number, currency: string) => number = (a) => a,
): { cardId: string; costHomeMinor: number } | null {
  let best: { cardId: string; costHomeMinor: number } | null = null;
  for (const c of cards) {
    let cost: number;
    if (c.billingCurrency === currency) cost = 0;
    else {
      const p = profiles.find((x) => x.cardId === c.id && x.fromCurrency === currency && x.toCurrency === c.billingCurrency);
      if (!p) continue; // unknown profile: no evidence, do not recommend
      cost = toHome(applyBps(amountMinor, p.medianMarkupBps), currency) + toHome(p.fixedFeeMinor, c.billingCurrency);
    }
    if (!best || cost < best.costHomeMinor || (cost === best.costHomeMinor && c.id < best.cardId)) best = { cardId: c.id, costHomeMinor: cost };
  }
  return best;
}

export interface DccInput {
  /** Charged amount in home currency (minor). */
  chargedHomeMinor: number;
  /** Local price at the merchant (minor) and its currency (≠ home: the purchase is abroad). */
  localAmountMinor: number;
  localCurrency: string;
  homeCurrency: string;
  midLocalToHome: Rational;
}

/** Returns overMidBps when DCC is flagged, else null. */
export function dccFlag(i: DccInput): { overMidBps: number } | null {
  if (i.localCurrency === i.homeCurrency) return null;
  const midHomeMinor = convertMinor(i.localAmountMinor, i.localCurrency, i.homeCurrency, i.midLocalToHome);
  if (midHomeMinor <= 0) return null;
  const over = div(sub(fromInt(i.chargedHomeMinor), fromInt(midHomeMinor)), fromInt(midHomeMinor));
  if (cmp(over, rat(BigInt(DCC_THRESHOLD_BPS), 10000n)) <= 0) return null;
  return { overMidBps: toSafeNumber(roundHalfUp(mul(over, rat(10000n)))) };
}
