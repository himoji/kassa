import { describe, expect, it } from "@jest/globals";

import { analytics, useFeatureFlag } from "@/lib/shims/analytics";

describe("analytics shim", () => {
  it("track/identify/screen are no-ops", () => {
    expect(() => {
      analytics.track("example_pressed", { source: "test" });
      analytics.identify("demo-user");
      analytics.screen("/");
      analytics.reset();
    }).not.toThrow();
  });

  it("feature flags are unknown", () => {
    expect(analytics.isFeatureEnabled("new-paywall")).toBeUndefined();
    expect(analytics.getFeatureFlag("new-paywall")).toBeUndefined();
    expect(useFeatureFlag("new-paywall")).toBeUndefined();
  });
});
