/* eslint-disable @typescript-eslint/no-require-imports -- screens load after jest.mock, as in the lite smoke test */
import { describe, expect, it, jest } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render } from "@testing-library/react-native";
import type { ReactElement } from "react";

import { ThemeProvider } from "@/components/ui";

/** Renders the Settings list and every detail screen it opens with realistic data, so a crash fails CI. */

const mockQ = (data: unknown) => ({
  data,
  isLoading: false,
  isError: false,
  isSuccess: true,
  status: "success",
  isRefetching: false,
  error: null,
  refetch: () => Promise.resolve(),
});
const mockMutation = () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false });
const mockNow = new Date().toISOString();
const mockToday = mockNow.slice(0, 10);
const mockPush = jest.fn();

jest.mock("@/api/hooks/me", () => ({
  useMe: () =>
    mockQ({
      id: "00000000-0000-4000-8000-000000000001",
      displayName: "Madiyar",
      homeCurrency: "KZT",
      region: "EU",
      preset: "SMART",
      moneyMode: "PAY_IN_PLACE",
      notificationMode: "EACH",
      frozenAt: null,
      settings: {
        preset: "SMART",
        region: "EU",
        homeCurrency: "KZT",
        notificationMode: "EACH",
        overrides: { agentAutonomy: null, paymentPolicy: null, moneyMode: null },
      },
      effective: {
        agentAutonomy: "PLAN_AHEAD",
        paymentPolicy: "RISK_BASED",
        moneyMode: "PAY_IN_PLACE",
      },
      demo: null,
    }),
  useFreeze: () => mockMutation(),
}));
jest.mock("@/api/hooks/wallet", () => ({
  useWallet: () => mockQ({ kassaId: "KS-4821-0937" }),
}));
jest.mock("@/api/hooks/settings", () => ({
  useCaps: () =>
    mockQ({
      caps: {
        currency: "KZT",
        perPaymentMinor: 150000000,
        perDayMinor: 300000000,
        perMonthMinor: 1000000000,
        smallAutoMinor: 1000000,
        reserveMinor: 5000000,
      },
    }),
  usePendingRuleChanges: () => mockQ({ changes: [] }),
  useUpdateSettings: () => mockMutation(),
  useEraseAccount: () => mockMutation(),
}));
jest.mock("@/api/hooks/payees", () => ({
  usePayees: () => mockQ({ payees: [] }),
  useMandates: () =>
    mockQ({
      mandates: [
        {
          id: "00000000-0000-4000-8000-0000000000m1",
          payeeIds: ["00000000-0000-4000-8000-0000000000p1"],
          categories: ["utilities"],
          currency: "KZT",
          maxPerPaymentMinor: 2000000,
          maxPerPeriodMinor: 4000000,
          period: "MONTH",
          validFrom: mockNow,
          validUntil: null,
          mandateHash: "abcdef0123456789",
          status: "ACTIVE",
          effectiveAt: mockNow,
          usedThisPeriodMinor: 0,
        },
      ],
    }),
  useCreateMandate: () => mockMutation(),
  useRevokeMandate: () => mockMutation(),
}));
jest.mock("@/api/hooks/money", () => ({
  useBudgets: () =>
    mockQ({
      homeCurrency: "KZT",
      budgets: ["groceries", "transport", "eating_out"].map((category, i) => ({
        id: `b${i}`,
        category,
        periodStart: mockToday,
        periodEnd: mockToday,
        limitHomeMinor: 20000000,
        spentHomeMinor: 385976,
        remainingHomeMinor: 19614024,
        daysLeft: 12,
        pace: "ON_TRACK",
        projectedRunOutDate: null,
      })),
    }),
  useSetBudgets: () => mockMutation(),
}));
jest.mock("@/api/hooks/auth", () => ({
  useRecoveryCodesStatus: () => mockQ({ remaining: 10, total: 10, createdAt: mockNow }),
  useCreateRecoveryCodes: () => mockMutation(),
  useDemoAvailability: () => mockQ({ enabled: false, judgeMode: false }),
}));
jest.mock("expo-router", () => {
  const actual = jest.requireActual<Record<string, unknown>>("expo-router");
  const Stack = Object.assign(() => null, { Screen: () => null });
  return {
    ...actual,
    Stack,
    router: {
      push: (...a: unknown[]) => mockPush(...a),
      navigate: jest.fn(),
      setParams: jest.fn(),
    },
    useLocalSearchParams: () => ({}),
  };
});
// @expo/ui's SwiftUI/Compose controls have no Jest renderer: a labelled stub per control.
jest.mock("@/components/kassa/native-controls", () => {
  const { Text } = jest.requireActual<typeof import("react-native")>("react-native");
  const Stub = ({ label, testID }: { label: string; testID?: string }) => (
    <Text testID={testID}>{label}</Text>
  );
  return { SettingPicker: Stub, SettingSwitch: Stub, SettingSlider: Stub };
});

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>{ui}</ThemeProvider>
    </QueryClientProvider>
  );
}

describe("settings screens render", () => {
  it("the Settings list shows each row's current value and opens the details", async () => {
    const { SettingsScreen } = require("../settings-screen");
    const r = await wrap(<SettingsScreen />);
    expect(r.getByTestId("kassa-id").props.children).toBe("KS-4821-0937");
    expect(r.getByTestId("settings-preset-value").props.children).toBe("Smart");
    expect(r.getByText("1 active")).toBeTruthy();
    expect(r.getByText("3 budgets")).toBeTruthy();
    expect(r.getByText("10 of 10 left")).toBeTruthy();
    expect(r.getByText(/per payment$/)).toBeTruthy();
    for (const [id, href] of [
      ["settings-preset", "/settings/preset"],
      ["settings-limits", "/settings/limits"],
      ["settings-mandates", "/settings/mandates"],
      ["settings-budgets", "/settings/budgets"],
      ["settings-backup-codes", "/settings/security"],
      ["settings-appearance", "/settings/appearance"],
      ["settings-demo-proof", "/settings/demo-proof"],
    ] as const) {
      await fireEvent.press(r.getByTestId(id));
      expect(mockPush).toHaveBeenLastCalledWith(href);
    }
  });

  it("every detail screen renders", async () => {
    const { PresetScreen } = require("../preset-screen");
    const sub = require("../settings-sub-screens");
    const preset = await wrap(<PresetScreen />);
    expect(preset.getAllByText("Smart").length).toBeGreaterThan(0);
    const limits = await wrap(<sub.LimitsScreen />);
    expect(limits.getByText("Per payment")).toBeTruthy();
    await wrap(<sub.MandatesScreen />);
    await wrap(<sub.BudgetsScreen />);
    await wrap(<sub.SecurityScreen />);
    const appearance = await wrap(<sub.AppearanceScreen />);
    expect(appearance.getByTestId("settings-language")).toBeTruthy();
    const demo = await wrap(<sub.DemoProofScreen />);
    expect(demo.getByText("Attack evidence")).toBeTruthy();
  });
});
