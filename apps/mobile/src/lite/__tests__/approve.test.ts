import { describe, expect, it, jest } from "@jest/globals";

import { KassaApiError } from "@/api/errors";
import { approveInWebAppUrl, LITE_RETURN_URL, openApproveInWebApp } from "../approve";

const mockOpen = jest.fn((_url: string, _redirect: string) => Promise.resolve({ type: "success" }));
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
