/** @jest-environment node */
import { beforeEach, describe, expect, it } from "@jest/globals";

import {
  clearReturnPath,
  clearReturnPathIfAt,
  peekReturnPath,
  rememberReturnPath,
  safeReturnPath,
} from "@/lib/return-path";

describe("return path after sign-in", () => {
  beforeEach(() => clearReturnPath());

  it("accepts same-app relative paths", () => {
    expect(safeReturnPath("/pay/bill_123")).toBe("/pay/bill_123");
    expect(safeReturnPath("/order/abc?x=1")).toBe("/order/abc?x=1");
  });

  it("refuses anything that could leave the app or loop back to sign-in", () => {
    for (const bad of [
      "https://evil.test/pay/1",
      "//evil.test/pay/1",
      "/\\evil.test",
      "javascript:alert(1)",
      "pay/1",
      "/pay/1\n",
      "",
      "/",
      "/welcome",
      "/login?x=1",
      "/register",
      42,
      undefined,
    ]) {
      expect(safeReturnPath(bad)).toBeNull();
    }
  });

  it("remembers a safe path until the user arrives on it", () => {
    rememberReturnPath("/pay/bill_123");
    expect(peekReturnPath()).toBe("/pay/bill_123");
    clearReturnPathIfAt("/home");
    expect(peekReturnPath()).toBe("/pay/bill_123");
    clearReturnPathIfAt("/pay/bill_123");
    expect(peekReturnPath()).toBeNull();
  });

  it("an unsafe path replaces nothing with nothing", () => {
    rememberReturnPath("/pay/bill_123");
    rememberReturnPath("https://evil.test");
    expect(peekReturnPath()).toBeNull();
  });
});
