import { describe, expect, it } from "@jest/globals";
import { resolveMode } from "../mode";

describe("resolveMode", () => {
  it("system follows the OS scheme", () => {
    expect(resolveMode("system", "dark")).toBe("dark");
    expect(resolveMode("system", "light")).toBe("light");
  });

  it("system with no OS scheme falls back to light", () => {
    expect(resolveMode("system", null)).toBe("light");
    expect(resolveMode("system", undefined)).toBe("light");
    expect(resolveMode("system", "unspecified")).toBe("light");
  });

  it("explicit modes win over the OS scheme", () => {
    expect(resolveMode("light", "dark")).toBe("light");
    expect(resolveMode("dark", "light")).toBe("dark");
    expect(resolveMode("dark", null)).toBe("dark");
  });
});
