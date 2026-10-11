import type {
  MandateOptionsRequest,
  OnboardingConfirmOptionsResponse,
  OnboardingConfirmResponse,
} from "@kassa/shared";

/** Step 2 of onboarding: the rent mandate the user may sign (or skip) after the base rules. */
export interface MandateOffer {
  mandate: MandateOptionsRequest;
  payees: { id: string; name: string }[];
}

/**
 * What follows a successful base-rules signature: the server's offer from the confirm response (computed
 * after the draft's bills exist), else the one the review already carried (e.g. a seeded rent bill).
 * null = no mandate to offer, go home.
 */
export function mandateOfferAfterRules(
  confirmed: OnboardingConfirmResponse,
  review: Pick<OnboardingConfirmOptionsResponse, "suggestedMandate" | "suggestedMandatePayees">
): MandateOffer | null {
  if (confirmed.suggestedMandate) {
    return { mandate: confirmed.suggestedMandate, payees: confirmed.suggestedMandatePayees };
  }
  if (review.suggestedMandate) {
    return { mandate: review.suggestedMandate, payees: review.suggestedMandatePayees };
  }
  return null;
}
