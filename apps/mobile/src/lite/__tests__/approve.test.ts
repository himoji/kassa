import { describe, expect, it, jest } from "@jest/globals";

import { KassaApiError } from "@/api/errors";
import {
  approveInWebAppUrl,
  LITE_RETURN_URL,
  liteWebAppUrl,
  openApproveInWebApp,
  openWebAppStep,
} from "../approve";

const mockOpen = jest.fn((_url: string, _redirect: string) => Promise.resolve({ type: "success" }));
let mockBase = "https://kassa.example/api";
jest.mock("@/api/client", () => ({
  api: {
    get baseUrl() {
      return mockBase;
    },
  },
  onApiError: () => () => {},
}));
jest.mock("expo-web-browser", () => ({
  openAuthSessionAsync: (url: string, redirect: string) => mockOpen(url, redirect),
}));

const refusal = (url: unknown) =>
  new KassaApiError(428, {
    error: "Approve in the web app",
    code: "PASSKEY_REQUIRED",
    details: { approveInWebApp: url },
  });

describe("approve in the web app", () => {
  it("only follows an https approval link from a 428", () => {
    const url = "https://kassa.example/order/abc?from=lite";
    expect(approveInWebAppUrl(refusal(url))).toBe(url);
    expect(approveInWebAppUrl(refusal("javascript:alert(1)"))).toBeNull();
    expect(
      approveInWebAppUrl(new KassaApiError(409, { error: "x", details: { approveInWebApp: url } }))
    ).toBeNull();
    expect(approveInWebAppUrl(new Error("x"))).toBeNull();
  });

  it("opens one auth session that returns to KassaLite", async () => {
    const url = "https://kassa.example/order/abc?from=lite";
    expect(await openApproveInWebApp(refusal(url), 10_000)).toBe(true);
    // A second refusal from a parallel retry does not open another sheet.
    expect(await openApproveInWebApp(refusal(url), 11_000)).toBe(true);
    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen).toHaveBeenCalledWith(url, LITE_RETURN_URL);
    expect(await openApproveInWebApp(new Error("x"), 20_000)).toBe(false);
  });
});

describe("passkey steps Lite opens in the web app", () => {
  it("opens the paired server's page with from=lite, and only over https", async () => {
    expect(liteWebAppUrl("/linked-accounts", { intent: "card" })).toBe(
      "https://kassa.example/linked-accounts?intent=card&from=lite"
    );
    mockOpen.mockClear();
    expect(await openWebAppStep("/linked-accounts", { intent: "bank" })).toBe(true);
    expect(mockOpen).toHaveBeenCalledWith(
      "https://kassa.example/linked-accounts?intent=bank&from=lite",
      LITE_RETURN_URL
    );
    mockBase = "http://192.168.1.5:4000/api";
    expect(liteWebAppUrl("/linked-accounts")).toBeNull();
    expect(await openWebAppStep("/linked-accounts")).toBe(false);
  });
});
