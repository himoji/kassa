/**
 * Onboarding navigation: sign base rules → rent mandate step (sign or skip) → home. The mandate comes from the
 * confirm response (a new user's rent bill only exists after the signed draft is applied), so the review itself
 * offers none; the app must still show step 2 and only then go home.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type {
  MandateOptionsRequest,
  OnboardingConfirmOptionsResponse,
  OnboardingConfirmResponse,
} from "@kassa/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { ThemeProvider } from "@/components/ui";
import { i18next } from "@/lib/i18n";
import { PasskeyCancelledError } from "@/lib/passkey-errors";
import { OnboardingReviewScreen } from "@/screens/onboarding/onboarding-review-screen";

const mockReplace = jest.fn();
const mockBack = jest.fn();
jest.mock("expo-router", () => ({
  ...jest.requireActual<object>("expo-router"),
  router: { replace: (...a: unknown[]) => mockReplace(...a), back: () => mockBack() },
}));

jest.mock("@/lib/haptics", () => ({ haptics: { success: () => {}, error: () => {} } }));

const mockConfirm =
  jest.fn<(r: OnboardingConfirmOptionsResponse) => Promise<OnboardingConfirmResponse>>();
const mockCreateMandate = jest.fn<(m: MandateOptionsRequest) => Promise<unknown>>();
let mockReview: OnboardingConfirmOptionsResponse;
jest.mock("@/api/hooks/onboarding", () => ({
  useOnboardingReview: () => ({
    data: mockReview,
    error: null,
    isPending: false,
    refetch: jest.fn(),
  }),
  useConfirmOnboarding: () => ({
    mutateAsync: (r: OnboardingConfirmOptionsResponse) => mockConfirm(r),
    isPending: false,
  }),
}));
jest.mock("@/api/hooks/payees", () => ({
  useCreateMandate: () => ({
    mutateAsync: (m: MandateOptionsRequest) => mockCreateMandate(m),
    isPending: false,
  }),
}));

const USER = "7d1d8d4c-1111-4a2b-8c3d-4e5f6a7b8c9d";
const LANDLORD = "9a8b7c6d-2222-4e3f-8a1b-2c3d4e5f6a7b";
const MANDATE: MandateOptionsRequest = {
  payeeIds: [LANDLORD],
  categories: ["rent"],
  currency: "HUF",
  maxPerPaymentMinor: 20_000_000,
  maxPerPeriodMinor: 20_000_000,
  period: "MONTH",
  validUntil: null,
};

function review(withMandate = false): OnboardingConfirmOptionsResponse {
  return {
    core: {
      v: 1,
      userId: USER,
      settings: {
        preset: "SMART",
        region: "EU",
        homeCurrency: "KZT",
        notificationMode: "EACH",
        overrides: { agentAutonomy: null, paymentPolicy: null, moneyMode: "CAPPED_WALLET" },
      },
      caps: {
        currency: "KZT",
        perPaymentMinor: 150_000_000,
        perDayMinor: 200_000_000,
        perMonthMinor: 300_000_000,
        smallAutoMinor: 1_000_000,
        reserveMinor: 5_000_000,
      },
    },
    rulesHash: "aGFzaA",
    challengeId: "c1",
    webauthnOptions: { challenge: "aGFzaA", rpId: "kassa.test", userVerification: "required" },
    draft: {
      displayName: "Dana",
      homeCurrency: "KZT",
      region: "EU",
      preset: "SMART",
      moneyMode: "CAPPED_WALLET",
      notificationMode: "EACH",
      incomes: [],
      obligations: [],
      budgets: [],
      cards: [],
    },
    suggestedMandate: withMandate ? MANDATE : null,
    suggestedMandatePayees: withMandate ? [{ id: LANDLORD, name: "Landlord in Budapest" }] : [],
  } as OnboardingConfirmOptionsResponse;
}

const confirmedWithMandate: OnboardingConfirmResponse = {
  onboarded: true,
  suggestedMandate: MANDATE,
  suggestedMandatePayees: [{ id: LANDLORD, name: "Landlord in Budapest" }],
};
const confirmedWithout: OnboardingConfirmResponse = {
  onboarded: true,
  suggestedMandate: null,
  suggestedMandatePayees: [],
};

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return (
    <QueryClientProvider client={qc}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}

const tr = (key: string) => i18next.t(key);

async function signRules() {
  await render(wrap(<OnboardingReviewScreen />));
  fireEvent.press(screen.getByText(tr("onboarding:signRules")));
}

describe("onboarding review → mandate → home", () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockConfirm.mockReset();
    mockCreateMandate.mockReset();
    mockReview = review(false);
  });

  it("after the rules are signed, shows the mandate step from the confirm response (not home)", async () => {
    mockConfirm.mockResolvedValue(confirmedWithMandate);
    await signRules();
    await waitFor(() => expect(screen.getByTestId("onboarding-mandate-step")).toBeTruthy());
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Landlord in Budapest")).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("skip for now → home", async () => {
    mockConfirm.mockResolvedValue(confirmedWithMandate);
    await signRules();
    await waitFor(() => expect(screen.getByText(tr("onboarding:skipMandate"))).toBeTruthy());
    fireEvent.press(screen.getByText(tr("onboarding:skipMandate")));
    expect(mockCreateMandate).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith("/home");
  });

  it("sign the mandate → creates exactly the offered mandate → home", async () => {
    mockConfirm.mockResolvedValue(confirmedWithMandate);
    mockCreateMandate.mockResolvedValue({});
    await signRules();
    await waitFor(() => expect(screen.getByText(tr("onboarding:signMandate"))).toBeTruthy());
    fireEvent.press(screen.getByText(tr("onboarding:signMandate")));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/home"));
    expect(mockCreateMandate).toHaveBeenCalledWith(MANDATE);
  });

  it("a cancelled mandate passkey stays on the mandate step", async () => {
    mockConfirm.mockResolvedValue(confirmedWithMandate);
    mockCreateMandate.mockRejectedValue(new PasskeyCancelledError());
    await signRules();
    await waitFor(() => expect(screen.getByText(tr("onboarding:signMandate"))).toBeTruthy());
    fireEvent.press(screen.getByText(tr("onboarding:signMandate")));
    await waitFor(() => expect(mockCreateMandate).toHaveBeenCalled());
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByTestId("onboarding-mandate-step")).toBeTruthy();
  });

  it("falls back to the review's offer (seeded rent bill)", async () => {
    mockReview = review(true);
    mockConfirm.mockResolvedValue(confirmedWithout);
    await signRules();
    await waitFor(() => expect(screen.getByTestId("onboarding-mandate-step")).toBeTruthy());
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("no mandate to offer → straight home", async () => {
    mockConfirm.mockResolvedValue(confirmedWithout);
    await signRules();
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/home"));
    expect(screen.queryByTestId("onboarding-mandate-step")).toBeNull();
  });
});
