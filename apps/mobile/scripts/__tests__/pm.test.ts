/** @jest-environment node */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  describePm,
  detectPm,
  isPmName,
  LOCKFILES,
  otherLockfiles,
  pm,
  PM_NAMES,
  PmError,
  renderCiTemplate,
} from "../lib/pm";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "readynative-pm-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const write = (rel: string, content: string) =>
  fs.writeFileSync(path.join(root, rel), content, "utf8");

const env = (agent?: string) =>
  (agent ? { npm_config_user_agent: agent } : {}) as NodeJS.ProcessEnv;
const noBun = () => false;
const withBun = () => true;

describe("command tables", () => {
  it("installs, freezes, runs and execs per package manager", () => {
    expect(pm("bun").install).toEqual(["bun", "install"]);
    expect(pm("pnpm").install).toEqual(["pnpm", "install"]);
    expect(pm("yarn").install).toEqual(["yarn", "install"]);
    expect(pm("npm").install).toEqual(["npm", "install"]);

    expect(pm("bun").frozenInstall).toEqual(["bun", "install", "--frozen-lockfile"]);
    expect(pm("pnpm").frozenInstall).toEqual(["pnpm", "install", "--frozen-lockfile"]);
    expect(pm("yarn").frozenInstall).toEqual(["yarn", "install", "--immutable"]);
    expect(pm("npm").frozenInstall).toEqual(["npm", "ci"]);

    expect(pm("bun").run("test", ["--ci"])).toEqual(["bun", "run", "test", "--ci"]);
    expect(pm("pnpm").run("test", ["--ci"])).toEqual(["pnpm", "run", "test", "--ci"]);
    expect(pm("yarn").run("test", ["--ci"])).toEqual(["yarn", "run", "test", "--ci"]);
    // npm hands bare flags to itself, so the script's arguments need `--`.
    expect(pm("npm").run("test", ["--ci"])).toEqual(["npm", "run", "test", "--", "--ci"]);
    expect(pm("npm").run("doctor")).toEqual(["npm", "run", "doctor"]);

    expect(pm("bun").exec("expo", ["install"])).toEqual(["bunx", "expo", "install"]);
    expect(pm("pnpm").exec("expo", ["install"])).toEqual(["pnpm", "exec", "expo", "install"]);
    expect(pm("yarn").exec("expo", ["install"])).toEqual(["yarn", "run", "expo", "install"]);
    expect(pm("npm").exec("expo", ["install"])).toEqual(["npx", "--no-install", "expo", "install"]);
  });

  it("describes itself by name and lockfile", () => {
    expect(describePm(pm("bun"))).toBe("bun (bun.lock)");
    expect(describePm(pm("npm"))).toBe("npm (package-lock.json)");
  });

  it("knows the other package managers' lockfiles", () => {
    expect(otherLockfiles("bun")).toEqual(["pnpm-lock.yaml", "yarn.lock", "package-lock.json"]);
    expect(otherLockfiles("npm")).toEqual(["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock"]);
    for (const name of PM_NAMES) {
      expect(otherLockfiles(name)).not.toContain(LOCKFILES[name][0]);
    }
  });

  it("validates names", () => {
    expect(isPmName("pnpm")).toBe(true);
    expect(isPmName("deno")).toBe(false);
  });
});

describe("detectPm", () => {
  it("takes --pm over everything else", () => {
    write("bun.lock", "");
    expect(detectPm(root, { override: "pnpm", env: env("bun/1.3.0") }).name).toBe("pnpm");
  });

  it("rejects an unknown --pm instead of falling back", () => {
    expect(() => detectPm(root, { override: "deno" })).toThrow(PmError);
    expect(() => detectPm(root, { override: "deno" })).toThrow(
      'Unknown package manager "deno" (expected bun | pnpm | yarn | npm)'
    );
  });

  it("takes the pm that launched the script over the tree", () => {
    write("bun.lock", "");
    write("package.json", JSON.stringify({ packageManager: "bun@1.3.0" }));
    expect(detectPm(root, { env: env("yarn/1.22.22 npm/? node/v24.0.0") }).name).toBe("yarn");
  });

  it("takes the packageManager field over the lockfile", () => {
    write("bun.lock", "");
    write("package.json", JSON.stringify({ packageManager: "pnpm@9.1.0" }));
    expect(detectPm(root, { env: env(), hasBun: withBun }).name).toBe("pnpm");
  });

  it("ignores an unusable packageManager field", () => {
    write("package.json", JSON.stringify({ packageManager: "cnpm@1.0.0" }));
    write("yarn.lock", "");
    expect(detectPm(root, { env: env(), hasBun: withBun }).name).toBe("yarn");
  });

  it("ignores a broken package.json", () => {
    write("package.json", "{ not json");
    write("pnpm-lock.yaml", "");
    expect(detectPm(root, { env: env(), hasBun: withBun }).name).toBe("pnpm");
  });

  it("falls back to the lockfile on disk", () => {
    write("package-lock.json", "{}");
    expect(detectPm(root, { env: env(), hasBun: withBun }).name).toBe("npm");
  });

  it("accepts the pre-1.2 bun lockfile", () => {
    write("bun.lockb", "");
    expect(detectPm(root, { env: env(), hasBun: noBun }).name).toBe("bun");
  });

  it("falls back to bun when it is installed", () => {
    expect(detectPm(root, { env: env(), hasBun: withBun }).name).toBe("bun");
  });

  it("falls back to npm when it is not", () => {
    expect(detectPm(root, { env: env(), hasBun: noBun }).name).toBe("npm");
  });
});

describe("renderCiTemplate", () => {
  const template = `jobs:
  check:
    steps:
      - uses: actions/checkout@v4
{{PM_SETUP}}
      - run: {{PM_INSTALL}}
      - run: {{PM_RUN}} typecheck
      - run: {{PM_RUN}} test --ci
      - if: \${{ github.event_name == 'push' }}
        run: {{PM_RUN}} lint
`;

  it("renders the bun variant (no node step)", () => {
    const ci = renderCiTemplate(template, pm("bun"));
    expect(ci).toContain(
      "      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: 1.4.0"
    );
    expect(ci).not.toContain("setup-node");
    expect(ci).toContain("      - run: bun install --frozen-lockfile");
    expect(ci).toContain("      - run: bun run typecheck");
    expect(ci).toContain("      - run: bun run test --ci");
  });

  it("renders pnpm with both setup steps", () => {
    const ci = renderCiTemplate(template, pm("pnpm"));
    expect(ci).toContain("      - uses: pnpm/action-setup@v4");
    expect(ci).toContain("          cache: pnpm");
    expect(ci).toContain("      - run: pnpm install --frozen-lockfile");
    expect(ci).toContain("      - run: pnpm run test --ci");
  });

  it("renders yarn and npm with setup-node only", () => {
    const yarn = renderCiTemplate(template, pm("yarn"));
    expect(yarn).toContain("      - uses: actions/setup-node@v4");
    expect(yarn).toContain("          cache: yarn");
    expect(yarn).toContain("      - run: yarn install --immutable");

    const npm = renderCiTemplate(template, pm("npm"));
    expect(npm).toContain("          cache: npm");
    expect(npm).toContain("      - run: npm ci");
    // The script's flags must not be eaten by npm itself.
    expect(npm).toContain("      - run: npm run test -- --ci");
  });

  it("leaves GitHub expressions alone", () => {
    for (const name of PM_NAMES) {
      expect(renderCiTemplate(template, pm(name))).toContain(
        "- if: ${{ github.event_name == 'push' }}"
      );
    }
    expect(renderCiTemplate(template, pm("npm"))).not.toContain("{{PM_");
  });
});
