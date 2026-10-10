import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PRESETS } from "../lib/catalog";
import {
  PRIVACY_POLICY_REL,
  loadStateForPrivacy,
  privacyFacts,
  renderPrivacyPolicy,
  writePrivacyPolicy,
} from "../lib/gen-privacy";
import type { ReadyNativeState } from "../lib/readynative-state";

const config = {
  app: { name: "Field Notes" },
  urls: { support: "mailto:hi@acme.io" },
  features: { tracking: false },
};

const ROW = {
  sdk: "PostHog (analytics/posthog)",
  collects: ["App interactions (events, screens)", "Device or other ids (distinct id)"],
  sharedWith: "PostHog (processor)",
  disclosureUrl: "https://posthog.com/docs/privacy",
};

function state(selection: Record<string, string>, rows = [ROW]): ReadyNativeState {
  return {
    version: 1,
    preset: null,
    selection,
    applied: true,
    modules: { app: { expo: {} }, postSetup: [], doctor: [], privacy: { dataSafety: rows } },
    keepModules: false,
    examples: false,
  };
}

describe("renderPrivacyPolicy", () => {
  it("names the app, owner, support channel and every processor row", () => {
    const md = renderPrivacyPolicy(
      config,
      state({ auth: "supabase", analytics: "posthog", crash: "sentry", consent: "consent" }),
      { owner: "Acme GmbH", date: "2026-09-21" }
    );
    expect(md).toContain("# Privacy Policy - Field Notes");
    expect(md).toContain("_Last updated: 2026-09-21_");
    expect(md).toContain("provided by Acme GmbH");
    expect(md).toContain("mailto:hi@acme.io");
    expect(md).toContain("| PostHog (analytics/posthog) |");
    expect(md).toContain("[PostHog (processor)](https://posthog.com/docs/privacy)");
    // Selection-driven paragraphs.
    expect(md).toContain("**Account data**");
    expect(md).toContain("**Usage data**");
    expect(md).toContain("only after you agree in the app");
    expect(md).toContain("**Crash reports**");
    expect(md).toContain('"Delete account"');
    expect(md).toContain("We do not track you across other companies");
    expect(md).toContain("we do not share it for cross-context behavioural advertising");
    // Native crash reports bypass the JS scrubber; the draft must not claim otherwise.
    expect(md).toContain("native crash reports");
    expect(md).toContain("## Legal basis");
    expect(md).toContain("## International transfers");
    expect(md).toContain("## How long we keep it");
    expect(md).toContain("Not legal advice");
  });

  it("never offers a switch the build does not have", () => {
    // consent/none + analytics: no per-category switches, but "Do not sell" exists.
    const md = renderPrivacyPolicy(
      config,
      state({ analytics: "posthog", crash: "sentry", consent: "none", auth: "none" })
    );
    expect(md).not.toContain("Settings → Privacy has a switch");
    expect(md).toContain('"Do not sell or share my personal information"');
    expect(md).toContain("It is always on, so we can fix crashes.");
    // Nothing to opt out of: no analytics, no "Do not sell" switch, no consent claims.
    const bare = renderPrivacyPolicy(config, state({ consent: "consent", auth: "none" }, []));
    expect(bare).not.toContain("Settings → Privacy has a switch");
    expect(bare).not.toContain("Do not sell or share my personal information");
    expect(bare).not.toContain("consent (Art. 6(1)(a)) where we ask");
    expect(bare).not.toContain("**Push token**");
  });

  it("derives the switches, the sheet and server deletion from the selection", () => {
    expect(privacyFacts({ app: { name: "x" } }, PRESETS.saas)).toMatchObject({
      consentSheet: true,
      toggles: true,
      doNotSell: true,
      serverDeletion: true,
      push: true,
    });
    expect(privacyFacts({ app: { name: "x" } }, PRESETS.default)).toMatchObject({
      consentSheet: false,
      toggles: false,
      doNotSell: false,
      serverDeletion: false,
      push: false,
    });
    expect(
      privacyFacts({ app: { name: "x" }, privacy: { askEverywhere: true } }, PRESETS.saas)
        .askEverywhere
    ).toBe(true);
  });

  it("leaves placeholders when the owner and support are unknown, and adapts to the selection", () => {
    const md = renderPrivacyPolicy(
      { app: { name: "X" }, urls: { support: "mailto:" }, features: { tracking: true } },
      state({ auth: "none", analytics: "amplitude", crash: "none", consent: "none" }, [])
    );
    expect(md).toContain("[YOUR COMPANY / NAME]");
    expect(md).toContain("[YOUR SUPPORT EMAIL OR FORM]");
    expect(md).toContain("_No third-party service is configured in this build._");
    expect(md).not.toContain("**Account data**");
    expect(md).toContain("It is on by default.");
    expect(md).toContain("App Tracking Transparency");
    // With tracking on, the "no sharing" claim would be false.
    expect(md).not.toContain("we do not share it for cross-context");
    expect(md).toContain("cross-context behavioural advertising");
    expect(md).toContain("uninstalling the app removes everything");
  });

  it("works without .readynative.json (older tree)", () => {
    const md = renderPrivacyPolicy(config, undefined, { date: "2026-09-21" });
    expect(md).toContain("**On-device data**");
    expect(md).toContain("_No third-party service is configured in this build._");
  });
});

describe("write / load", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "readynative-gen-privacy-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes docs/privacy-policy.md and reads the state file when present", () => {
    expect(loadStateForPrivacy(root)).toBeUndefined();
    fs.writeFileSync(path.join(root, ".readynative.json"), JSON.stringify(state({ auth: "none" })));
    expect(loadStateForPrivacy(root)?.modules.privacy?.dataSafety).toEqual([ROW]);

    expect(writePrivacyPolicy(root, "# hi\n")).toBe(PRIVACY_POLICY_REL);
    expect(fs.readFileSync(path.join(root, PRIVACY_POLICY_REL), "utf8")).toBe("# hi\n");
  });
});
