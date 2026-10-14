import { afterEach, describe, expect, it, jest } from "@jest/globals";
const ORIGINAL = process.env.EXPO_PUBLIC_APP_VARIANT;

type EnvModule = {
  env: { APP_VARIANT: string };
  envPresence: readonly { key: string; set: boolean }[];
};

function loadEnv(): EnvModule {
  let mod: EnvModule | undefined;
  jest.isolateModules(() => {
    mod = jest.requireActual<EnvModule>("../env");
  });
  return mod!;
}

describe("env", () => {
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.EXPO_PUBLIC_APP_VARIANT;
    else process.env.EXPO_PUBLIC_APP_VARIANT = ORIGINAL;
  });

  it("defaults APP_VARIANT to dev when unset", () => {
    delete process.env.EXPO_PUBLIC_APP_VARIANT;
    expect(loadEnv().env.APP_VARIANT).toBe("dev");
  });

  it("treats an empty string as unset", () => {
    process.env.EXPO_PUBLIC_APP_VARIANT = "";
    expect(loadEnv().env.APP_VARIANT).toBe("dev");
  });

  it("reads a valid variant", () => {
    process.env.EXPO_PUBLIC_APP_VARIANT = "preview";
    expect(loadEnv().env.APP_VARIANT).toBe("preview");
  });

  it("accepts lite, the variant `bun run ota lite` bundles with", () => {
    process.env.EXPO_PUBLIC_APP_VARIANT = "lite";
    expect(loadEnv().env.APP_VARIANT).toBe("lite");
  });

  it("envPresence says which keys are set, never their values", () => {
    delete process.env.EXPO_PUBLIC_APP_VARIANT;
    const unset = loadEnv().envPresence;
    expect(unset).toContainEqual({ key: "EXPO_PUBLIC_APP_VARIANT", set: false });

    process.env.EXPO_PUBLIC_APP_VARIANT = "preview";
    const set = loadEnv().envPresence;
    expect(set).toContainEqual({ key: "EXPO_PUBLIC_APP_VARIANT", set: true });
    for (const entry of set) expect(Object.keys(entry).sort()).toEqual(["key", "set"]);
    expect(JSON.stringify(set)).not.toContain("preview");
  });

  it("throws on an invalid variant", () => {
    process.env.EXPO_PUBLIC_APP_VARIANT = "staging";
    expect(() => loadEnv()).toThrow(/Invalid EXPO_PUBLIC_\* environment/);
  });
});
