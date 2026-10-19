/**
 * Convert: the screen posts the ConvertRequest built from its (prefilled) inputs and opens the order sheet on ASK;
 * a refusal is explained with its reason codes and nothing opens.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";

import { api } from "@/api/client";
import { ThemeProvider } from "@/components/ui";
import { ConvertScreen } from "@/screens/wallet/convert-screen";

const mockParams: { current: Record<string, string> } = { current: {} };
jest.mock("expo-router", () => ({
  ...jest.requireActual<object>("expo-router"),
  router: { push: jest.fn() },
  useLocalSearchParams: () => mockParams.current,
}));
jest.mock("@/api/client", () => ({ api: { request: jest.fn() } }));
jest.mock("@/lib/haptics", () => ({
  haptics: { success: jest.fn(), warning: jest.fn(), error: jest.fn(), selection: jest.fn() },
}));

const PROPOSAL_ID = "0b6b5d3c-6a3f-4c84-9d5e-2f1f7f0a1b11";
const request = api.request as jest.MockedFunction<typeof api.request>;

const wrap = () => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ThemeProvider>
      <ConvertScreen />
    </ThemeProvider>
  </QueryClientProvider>
);

/** Press Review and let the mutation (and its query invalidation) settle inside act. */
async function submit() {
  await act(async () => {
    fireEvent.press(screen.getByText("Review conversion"));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("ConvertScreen", () => {
  beforeEach(() => {
    request.mockReset();
    (router.push as jest.Mock).mockReset();
  });

  it("posts the prefilled conversion and opens the order sheet on ASK", async () => {
    mockParams.current = { fromCurrency: "KZT", toCurrency: "EUR", amountMinor: "210050" };
    request.mockResolvedValue({
      proposalId: PROPOSAL_ID,
      decision: "ASK",
      reasonCodes: ["CONVERT_OWN_BALANCES"],
      summary: "Convert",
    } as never);
    await render(wrap());
    await submit();
    expect(router.push).toHaveBeenCalledWith(`/order/${PROPOSAL_ID}`);
    expect(request).toHaveBeenCalledWith(
      "/conversions",
      expect.objectContaining({
        json: { toCurrency: "EUR", amountMinor: 210050, fromCurrency: "KZT" },
      })
    );
  });

  it("the cheapest balance sends no fromCurrency", async () => {
    mockParams.current = { toCurrency: "EUR", amountMinor: "5000" };
    request.mockResolvedValue({
      proposalId: PROPOSAL_ID,
      decision: "ASK",
      reasonCodes: [],
      summary: "",
    } as never);
    await render(wrap());
    await submit();
    expect(router.push).toHaveBeenCalled();
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      json: { toCurrency: "EUR", amountMinor: 5000 },
    });
    expect(
      (request.mock.calls[0]?.[1] as { json: Record<string, unknown> }).json
    ).not.toHaveProperty("fromCurrency");
  });

  it("a refusal shows its reason and opens nothing", async () => {
    mockParams.current = { fromCurrency: "KZT", toCurrency: "EUR", amountMinor: "210050" };
    request.mockResolvedValue({
      proposalId: PROPOSAL_ID,
      decision: "REFUSE",
      reasonCodes: ["INSUFFICIENT_FUNDS"],
      summary: "refused",
    } as never);
    await render(wrap());
    await submit();
    expect(screen.getByTestId("convert-refused")).toBeTruthy();
    expect(screen.getByText("Not enough money")).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });
});
