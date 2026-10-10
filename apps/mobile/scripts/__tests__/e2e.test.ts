/** @jest-environment node */
import { describe, expect, it } from "@jest/globals";

import {
  cmdLine,
  e2eEnv,
  formatCommand,
  maestroArgs,
  parseE2eArgs,
  parseVariant,
  quoteForCmd,
  type E2eConfigInput,
} from "../lib/e2e";

const placeholder: E2eConfigInput = {
  app: { name: "ReadyNative", ios: { bundleId: "com.acme.app" } },
};

const rebranded: E2eConfigInput = {
  app: { name: "Acme", ios: { bundleId: "io.acme.ios" } },
};

describe("e2eEnv", () => {
  it("suffixes the bundle id per variant (same rule as app.config.ts)", () => {
    expect(e2eEnv(placeholder, "dev").APP_ID).toBe("com.acme.app.dev");
    expect(e2eEnv(placeholder, "preview").APP_ID).toBe("com.acme.app.preview");
    expect(e2eEnv(placeholder, "prod").APP_ID).toBe("com.acme.app");
  });

  it("defaults to the dev variant", () => {
    expect(e2eEnv(placeholder)).toEqual({
      APP_ID: "com.acme.app.dev",
      APP_NAME: "ReadyNative",
      APP_DISPLAY_NAME: "ReadyNative (Dev)",
    });
  });

  it("keeps APP_NAME unsuffixed and mirrors app.config.ts in APP_DISPLAY_NAME", () => {
    expect(e2eEnv(rebranded, "preview")).toEqual({
      APP_ID: "io.acme.ios.preview",
      APP_NAME: "Acme",
      APP_DISPLAY_NAME: "Acme (Preview)",
    });
    expect(e2eEnv(rebranded, "prod").APP_DISPLAY_NAME).toBe("Acme");
  });
});

describe("parseVariant", () => {
  it("accepts the EAS profile aliases", () => {
    expect(parseVariant(undefined)).toBe("dev");
    expect(parseVariant("development")).toBe("dev");
    expect(parseVariant("production")).toBe("prod");
    expect(parseVariant("preview")).toBe("preview");
  });

  it("rejects unknown variants", () => {
    expect(() => parseVariant("staging")).toThrow(/Unknown --variant "staging"/);
  });
});

describe("parseE2eArgs", () => {
  it("defaults to dev, no dry run, no extra args", () => {
    expect(parseE2eArgs([])).toEqual({
      variant: "dev",
      dryRun: false,
      help: false,
      root: undefined,
      extra: [],
    });
  });

  it("reads --variant / --root in both spellings and --dry-run", () => {
    expect(parseE2eArgs(["--variant", "production", "--root", "/tmp/x", "--dry-run"])).toEqual({
      variant: "prod",
      dryRun: true,
      help: false,
      root: "/tmp/x",
      extra: [],
    });
    expect(parseE2eArgs(["--variant=preview", "--root=/tmp/y"])).toMatchObject({
      variant: "preview",
      root: "/tmp/y",
    });
  });

  it("forwards unknown flags and flow paths to maestro", () => {
    expect(parseE2eArgs(["--format", "junit", ".maestro/flows/onboarding.yaml"]).extra).toEqual([
      "--format",
      "junit",
      ".maestro/flows/onboarding.yaml",
    ]);
  });

  it("throws when a value flag has no value", () => {
    expect(() => parseE2eArgs(["--variant"])).toThrow(/--variant needs a value/);
  });
});

describe("maestroArgs / formatCommand", () => {
  it("passes every variable as -e and targets the flows directory", () => {
    expect(maestroArgs(e2eEnv(placeholder))).toEqual([
      "test",
      "-e",
      "APP_ID=com.acme.app.dev",
      "-e",
      "APP_NAME=ReadyNative",
      "-e",
      "APP_DISPLAY_NAME=ReadyNative (Dev)",
      ".maestro/flows",
    ]);
  });

  it("lets a positional extra arg replace the default flows directory", () => {
    const args = maestroArgs(e2eEnv(placeholder), ["--format", "junit", "a.yaml"]);
    expect(args.slice(-3)).toEqual(["--format", "junit", "a.yaml"]);
    expect(args).not.toContain(".maestro/flows");
  });

  it("renders a copy-pasteable command", () => {
    expect(formatCommand(maestroArgs(e2eEnv(rebranded, "prod")))).toBe(
      "maestro test -e APP_ID=io.acme.ios -e APP_NAME=Acme -e APP_DISPLAY_NAME=Acme .maestro/flows"
    );
  });
});

describe("quoteForCmd / cmdLine (Windows shell spawn)", () => {
  it("keeps a spaced, parenthesised value one argument and escapes cmd metacharacters", () => {
    expect(quoteForCmd("APP_DISPLAY_NAME=Acme (Dev)")).toBe('^"APP_DISPLAY_NAME=Acme^ ^(Dev^)^"');
    expect(quoteForCmd("A&B|C%PATH%^!")).toBe('^"A^&B^|C^%PATH^%^^^!^"');
  });

  it("escapes embedded quotes and trailing backslashes for CommandLineToArgvW", () => {
    expect(quoteForCmd('say "hi"')).toBe('^"say^ \\^"hi\\^"^"');
    expect(quoteForCmd("C:\\dir\\")).toBe('^"C:\\dir\\\\^"');
    expect(quoteForCmd('a\\"b')).toBe('^"a\\\\\\^"b^"');
  });

  it("builds the full line with the command unquoted", () => {
    expect(cmdLine("maestro", ["test", "-e", "APP_NAME=Acme & Co"])).toBe(
      'maestro ^"test^" ^"-e^" ^"APP_NAME=Acme^ ^&^ Co^"'
    );
  });
});
