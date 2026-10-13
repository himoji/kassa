import { describe, expect, it } from "@jest/globals";
import type { OnboardingProfileDraft } from "@kassa/shared";

import { hasContent } from "@/screens/onboarding/draft-content";

const EMPTY: OnboardingProfileDraft = {
  displayName: null,
  homeCurrency: null,
  region: null,
  preset: null,
  moneyMode: null,
  notificationMode: null,
  incomes: [],
  obligations: [],
  budgets: [],
  cards: [],
};

describe("hasContent", () => {
  it("is false for an empty draft", () => {
    expect(hasContent(EMPTY)).toBe(false);
  });

  it("is true once any scalar field is set", () => {
    expect(hasContent({ ...EMPTY, displayName: "Ana" })).toBe(true);
    expect(hasContent({ ...EMPTY, homeCurrency: "HUF" })).toBe(true);
    expect(hasContent({ ...EMPTY, notificationMode: "EACH" })).toBe(true);
  });

  it("is true once any list is non-empty", () => {
    expect(hasContent({ ...EMPTY, budgets: [{ category: "food", limitHomeMinor: 5000 }] })).toBe(
      true
    );
    expect(
      hasContent({
        ...EMPTY,
        cards: [{ label: "Visa", last4: "4242", billingCurrency: "HUF", kind: "USD" }],
      })
    ).toBe(true);
  });
});
