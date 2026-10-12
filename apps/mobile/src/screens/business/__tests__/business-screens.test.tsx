/**
 * Business M4: the Today shortage alert and the Stock list render the forecast as the API returns it (Shanghai,
 * 400 boxes short); the scheduler's "business.shortage" notification renders through i18n.
 */
import { describe, expect, it, jest } from "@jest/globals";
import type {
  BusinessForecastResponse,
  BusinessInventoryResponse,
  BusinessSalesTodayResponse,
} from "@kassa/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { ThemeProvider } from "@/components/ui";
import { i18next } from "@/lib/i18n";
import { notificationText } from "@/screens/activity/notification-text";
import { poStatusTone, qtyText } from "@/screens/business/business-text";
import { StockScreen } from "@/screens/business/stock-screen";
import { TodayScreen } from "@/screens/business/today-screen";

jest.mock("expo-router", () => ({
  ...jest.requireActual<object>("expo-router"),
  router: { push: jest.fn() },
}));

const MERCHANT = {
  id: "42178da4-27f6-528d-b070-7384ac1520a5",
  slug: "sha",
  name: "Pizza Shop in Shanghai",
  currency: "CNY",
  timezone: "Asia/Shanghai",
};
const BOX = {
  sku: "BOX-33CM",
  name: "Pizza box 33 cm",
  unit: "pcs",
  demandToday: 400,
  demandTomorrow: 420,
  need: 820,
  safety: 82,
  onHand: 502,
  incoming: 0,
  shortage: 400,
};
const mockForecast: BusinessForecastResponse = {
  merchant: MERCHANT,
  today: "2026-10-27",
  tomorrow: "2026-10-28",
  generatedAt: "2026-10-27T09:00:00.000Z",
  lines: [],
  shortages: [
    {
      ...BOX,
      suggestion: {
        supplierPayeeId: "a0326d52-4f69-5b38-bb3a-ee31cb4e4813",
        supplierName: "Supplier C",
        verified: true,
        supplierSku: "BOX-33CM-100",
        packSize: 100,
        packs: 4,
        packPriceMinor: 18000,
        lineTotalMinor: 72000,
        currency: "CNY",
        leadTimeDays: 1,
        arrivesBy: "2026-10-28",
        late: false,
      },
    },
  ],
};
const mockSales: BusinessSalesTodayResponse = {
  merchant: MERCHANT,
  day: "2026-10-27",
  totalUnits: 3,
  revenueMinor: 20400,
  items: [],
};
const mockInventory: BusinessInventoryResponse = {
  merchant: MERCHANT,
  items: [
    {
      sku: BOX.sku,
      name: BOX.name,
      unit: "pcs",
      onHand: 502,
      need: 820,
      safety: 82,
      incoming: 0,
      shortage: 400,
    },
    {
      sku: "COLA-BTL",
      name: "Cola 0.5 l bottle",
      unit: "pcs",
      onHand: 900,
      need: 300,
      safety: 30,
      incoming: 0,
      shortage: 0,
    },
  ],
};
const mockOk = <T,>(data: T) => ({
  data,
  error: null,
  isPending: false,
  isRefetching: false,
  refetch: jest.fn(),
});
jest.mock("@/api/hooks/business", () => ({
  useBusinessForecast: () => mockOk(mockForecast),
  useSalesToday: () => mockOk(mockSales),
  useBusinessInventory: () => mockOk(mockInventory),
}));

const wrap = (children: ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>
    <ThemeProvider>{children}</ThemeProvider>
  </QueryClientProvider>
);
const t = (key: string, vars?: Record<string, string | number>) => i18next.t(key, vars);

describe("Business screens", () => {
  it("Today shows the shortage alert with the suggested packs", async () => {
    await render(wrap(<TodayScreen />));
    expect(screen.getByTestId("business-shortage-alert")).toBeTruthy();
    expect(screen.getByText("Pizza box 33 cm: 400 pcs short")).toBeTruthy();
    expect(screen.getByText(/Suggested: 4 × 100 pcs from Supplier C/)).toBeTruthy();
    expect(screen.getByText("3 items sold")).toBeTruthy();
  });

  it("Stock lists on-hand, need (incl. safety) and the shortage", async () => {
    await render(wrap(<StockScreen />));
    expect(screen.getByText("On hand 502 pcs · need 902 pcs")).toBeTruthy();
    expect(screen.getByText("400 pcs short")).toBeTruthy();
    expect(screen.getByText("Covered")).toBeTruthy();
  });

  it("helpers and the business.shortage notification", () => {
    expect(qtyText(2500, "g", t, "en")).toBe("2,500 g");
    expect(qtyText(3, "box", t, "en")).toBe("3 box");
    expect(poStatusTone("DRAFT")).toBe("warning");
    const n = notificationText(
      {
        title: "x",
        body: "y",
        data: {
          key: "business.shortage",
          params: {
            items: [{ sku: "BOX-33CM", name: "Pizza box 33 cm", unit: "pcs", shortage: 400 }],
            supplier: "Supplier C",
            total: { amountMinor: 72000, currency: "CNY" },
          },
        },
      },
      t,
      (a, c) => `${c} ${(a / 100).toFixed(2)}`
    );
    expect(n.title).toBe("Stock will run short by tomorrow");
    expect(n.body).toContain("Pizza box 33 cm (400 pcs)");
    expect(n.body).toContain("Supplier C (CNY 720.00)");
  });
});
