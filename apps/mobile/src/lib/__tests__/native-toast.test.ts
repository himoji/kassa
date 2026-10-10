import { describe, expect, it, jest } from "@jest/globals";

/** Loads `@/lib/native-toast` on `os`, with or without Burnt's native module in the build. */
function load(os: string, hasBurnt: boolean) {
  const toast = jest.fn(async () => {});
  let mod!: typeof import("@/lib/native-toast");
  jest.isolateModules(() => {
    jest.doMock("react-native", () => ({ Platform: { OS: os } }));
    jest.doMock("expo", () => ({ requireOptionalNativeModule: () => (hasBurnt ? {} : null) }));
    jest.doMock("burnt", () => ({ toast }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules needs require
    mod = require("@/lib/native-toast") as typeof import("@/lib/native-toast");
  });
  return { ...mod, toast };
}

describe("native toast", () => {
  it("shows a Burnt toast on iOS builds that carry it, mapping kind and duration", () => {
    const { showNativeToast, toast } = load("ios", true);

    expect(showNativeToast({ title: "Saved", description: "All good", kind: "success" })).toBe(
      true
    );
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Saved",
        message: "All good",
        preset: "done",
        haptic: "success",
        duration: 3,
      })
    );
  });

  it("declines in Expo Go (no native module), so the kit's own toast renders", () => {
    const { showNativeToast, nativeToastAvailable, toast } = load("ios", false);
    expect(nativeToastAvailable).toBe(false);
    expect(showNativeToast({ title: "Saved" })).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it("declines on Android and web", () => {
    expect(load("android", true).showNativeToast({ title: "x" })).toBe(false);
    expect(load("web", true).showNativeToast({ title: "x" })).toBe(false);
  });
});
