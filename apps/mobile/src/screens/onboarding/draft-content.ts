import type { OnboardingProfileDraft } from "@kassa/shared";

/** True once the draft holds at least one answer worth summarising (an empty draft stays hidden). */
export function hasContent(draft: OnboardingProfileDraft): boolean {
  return (
    draft.displayName !== null ||
    draft.homeCurrency !== null ||
    draft.region !== null ||
    draft.preset !== null ||
    draft.moneyMode !== null ||
    draft.notificationMode !== null ||
    draft.incomes.length > 0 ||
    draft.obligations.length > 0 ||
    draft.budgets.length > 0 ||
    draft.cards.length > 0
  );
}
