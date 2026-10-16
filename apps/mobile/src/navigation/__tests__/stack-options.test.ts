import { describe, expect, it } from "@jest/globals";

import { iosHeaderBlur } from "../stack-options";

describe("iosHeaderBlur", () => {
  it("leaves the large-title bar to iOS 26's own scroll edge effect; blurs only older iOS", () => {
    expect(iosHeaderBlur("ios", "26.0")).toBeUndefined();
    expect(iosHeaderBlur("ios", "27.1")).toBeUndefined();
    expect(iosHeaderBlur("ios", "18.6")).toBe("systemChromeMaterial");
    expect(iosHeaderBlur("android", 35)).toBeUndefined();
  });
});
