/**
 * `bun run gen:privacy`: a privacy-policy draft from what the tree actually ships.
 *
 * Inputs are the two files a finalized tree still has: `readynative.config.ts`
 * (app name, urls) and `.readynative.json` (`modules.privacy.dataSafety`, the
 * rows setup composed from every selected module's `privacy.playDataSafety`;
 * `selection` for the consent / auth story). No module.json is read, so this
 * runs after `modules/` is gone. The output is a starting point for a lawyer,
 * not legal advice - the header says so.
 */
import fs from "node:fs";
import path from "node:path";

import type { DataSafetyRow, ReadyNativeState } from "./readynative-state.ts";

export const PRIVACY_POLICY_REL = "docs/privacy-policy.md";

export interface PrivacyConfigInput {
  app: { name: string };
  urls?: { support?: string; privacy?: string; website?: string };
  features?: { tracking?: boolean };
  privacy?: { askEverywhere?: boolean };
}

export interface RenderPrivacyOptions {
  /** ISO date printed as "Last updated"; defaults to today. */
  date?: string;
  /** Legal entity behind the app; a placeholder when unknown. */
  owner?: string;
}

const PLACEHOLDER_OWNER = "[YOUR COMPANY / NAME]";

function bullet(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join("\n");
}

/** Display names of the services a selection can contain (module option → vendor). */
const VENDOR: Record<string, string> = {
  posthog: "PostHog",
  amplitude: "Amplitude",
  sentry: "Sentry",
  supabase: "Supabase",
  clerk: "Clerk",
  "better-auth": "our own server (Better Auth)",
  revenuecat: "RevenueCat",
  adapty: "Adapty",
  stripe: "our Stripe integration",
};

function picked(selection: Record<string, string>, category: string): string | undefined {
  const option = selection[category];
  return option !== undefined && option !== "none" && option !== "off" ? option : undefined;
}

/**
 * Everything the policy says, derived from the selection and the config. Each sentence of
 * the draft reads one of these, so the text can only claim what the build does.
 */
export interface PrivacyFacts {
  auth?: string;
  analytics?: string;
  crash?: string;
  payments?: string;
  push: boolean;
  /** `consent/consent`: the sheet asks before analytics / crash start where the law requires. */
  consentSheet: boolean;
  askEverywhere: boolean;
  /** Per-category switches in Settings → Privacy (consent module + that category). */
  toggles: boolean;
  /** "Do not sell or share" switch (any consent option, when analytics exists). */
  doNotSell: boolean;
  /** `backend/api-routes`: account deletion also erases the user at the configured vendors. */
  serverDeletion: boolean;
  tracking: boolean;
}

export function privacyFacts(
  config: PrivacyConfigInput,
  selection: Record<string, string>
): PrivacyFacts {
  const analytics = picked(selection, "analytics");
  const crash = picked(selection, "crash");
  const consentSheet = selection.consent === "consent" && Boolean(analytics || crash);
  return {
    auth: picked(selection, "auth"),
    analytics,
    crash,
    payments: picked(selection, "payments"),
    push: picked(selection, "push") !== undefined,
    consentSheet,
    askEverywhere: consentSheet && config.privacy?.askEverywhere === true,
    toggles: consentSheet,
    doNotSell: analytics !== undefined,
    serverDeletion: picked(selection, "backend") === "api-routes",
    tracking: config.features?.tracking === true,
  };
}

function vendor(option: string | undefined): string {
  return option ? (VENDOR[option] ?? option) : "";
}

function whatWeCollect(f: PrivacyFacts): string[] {
  const out: string[] = [];
  if (f.auth) {
    out.push(
      `**Account data** - your email address, name and a user id when you create an account or sign in (held by ${vendor(f.auth)}). Used to run your account.`
    );
  }
  if (f.payments) {
    const store =
      f.payments === "stripe"
        ? "Stripe, which processes your card"
        : "the App Store / Google Play, which process the payment";
    out.push(
      `**Purchases** - what you bought and whether your subscription is active, with a customer id, handled by ${vendor(f.payments)} and ${store}. We never see your card details.`
    );
  }
  if (f.analytics) {
    const when = f.consentSheet
      ? f.askEverywhere
        ? "Only after you agree in the app."
        : "Where the law requires it (the EU/EEA, the UK, Switzerland, Canada and Brazil, or when the device region is unknown) only after you agree in the app; elsewhere it is on until you turn it off."
      : "It is on by default.";
    out.push(
      `**Usage data** - which screens and features you use, a device id and, if you are signed in and we link it, your user id; ${vendor(f.analytics)} may derive your approximate location (country, city) from your IP address. ${when}`
    );
  }
  if (f.crash) {
    const when = f.consentSheet
      ? f.askEverywhere
        ? "Only after you agree in the app."
        : "Where the law requires it, only after you agree in the app; elsewhere it is on until you turn it off."
      : "It is always on, so we can fix crashes.";
    out.push(
      `**Crash reports** - the error, app version, device model and OS when something breaks. For errors caught in the app's JavaScript, email addresses, tokens, request headers, cookies and URL query strings are removed from the report and its breadcrumbs before it is sent; native crash reports (the app itself crashing) are sent as the operating system's crash handler records them - stack traces and device details, without that filtering. The connection itself reveals your IP address to ${vendor(f.crash)} [CONFIRM: "which does not store it" once "Prevent Storing of IP Addresses" is on in Sentry → Security & Privacy]. ${when}`
    );
  }
  if (f.push) {
    out.push(
      "**Push token** - if you allow notifications, Apple or Google issue a device token that Expo's push service uses to deliver them. The app keeps it on your device [CONFIRM: and sends it to our server, where we keep it until you sign out or delete your account]."
    );
  }
  out.push(
    "**On-device data** - your preferences (theme, language, privacy choices) and what the app caches for you, stored only on your device." +
      (f.auth ? " Signing out removes everything except your preferences and privacy choices." : "")
  );
  return out;
}

function legalBasis(f: PrivacyFacts): string[] {
  const out: string[] = [];
  if (f.auth) out.push("**Account data** - to perform our contract with you (GDPR Art. 6(1)(b)).");
  if (f.payments) {
    out.push(
      "**Purchases** - to perform our contract with you (Art. 6(1)(b)) and to keep the records tax law requires (Art. 6(1)(c))."
    );
  }
  const optional = [f.analytics ? "Usage data" : "", f.crash ? "Crash reports" : ""]
    .filter(Boolean)
    .join(" and ");
  if (optional) {
    out.push(
      f.consentSheet
        ? `**${optional}** - your consent (Art. 6(1)(a)) where we ask for it; elsewhere our legitimate interest in understanding and fixing the app (Art. 6(1)(f)), which you can object to in Settings → Privacy.`
        : `**${optional}** - our legitimate interest in understanding and fixing the app (Art. 6(1)(f)).`
    );
  }
  if (f.push)
    out.push(
      "**Push token** - your consent, given through the notification prompt (Art. 6(1)(a))."
    );
  out.push("**On-device data** - stays on your device; we do not receive it.");
  return out;
}

function retention(f: PrivacyFacts): string[] {
  const out: string[] = [];
  if (f.auth) out.push("**Account data** - until you delete your account.");
  if (f.payments) {
    out.push(
      "**Purchases** - for as long as the law requires us to keep transaction records [CONFIRM: period for your country]."
    );
  }
  if (f.analytics) {
    out.push(
      `**Usage data** - [CONFIRM: the retention period set in ${vendor(f.analytics)}], or until you delete your account${f.serverDeletion ? "" : " and ask us to remove it"}.`
    );
  }
  if (f.crash)
    out.push(
      `**Crash reports** - [CONFIRM: the retention period of your ${vendor(f.crash)} plan].`
    );
  out.push(
    f.auth
      ? "**On-device data** - until you sign out, delete your account or uninstall the app."
      : "**On-device data** - until you uninstall the app."
  );
  return out;
}

function yourChoices(f: PrivacyFacts): string[] {
  const out: string[] = [];
  if (f.toggles) {
    const cats = [f.analytics ? "analytics" : "", f.crash ? "crash reports" : ""]
      .filter(Boolean)
      .join(" and ");
    out.push(
      `**Consent** - Settings → Privacy has a switch for ${cats}; turning one off stops it immediately.`
    );
  }
  if (f.doNotSell) {
    out.push(
      '**Do not sell or share** - we do not sell your personal information. Settings → Privacy → "Do not sell or share my personal information" also turns analytics off (California and similar laws).'
    );
  }
  out.push(
    '**Export** - Settings → Privacy → "Export my data" gives you a file (`my-data-<date>.json`) with what the app stores on your device' +
      (f.auth ? " and your account profile." : ".") +
      (f.auth || f.analytics || f.crash || f.payments || f.push
        ? " For a copy of the data our service providers hold, contact us."
        : "")
  );
  if (f.auth) {
    const vendors = [f.analytics, f.payments]
      .filter((v): v is string => Boolean(v))
      .map(vendor)
      .join(" and ");
    const alsoVendors =
      f.serverDeletion && vendors
        ? ` The app also asks ${vendors} to delete what they hold about your account [CONFIRM: their server keys are set - see docs/privacy].`
        : vendors
          ? ` To remove what ${vendors} hold about you, contact us.`
          : "";
    out.push(
      `**Delete** - Settings → Account → "Delete account" permanently deletes your account and its data${f.auth === "supabase" ? ", including your uploaded files" : ""}, then clears the app's local data.${alsoVendors}`
    );
  } else {
    out.push("**Delete** - uninstalling the app removes everything it stored on your device.");
  }
  out.push(
    "**Access, correction, restriction, objection, portability** - contact us; we answer within one month. In the EU/UK you can also complain to your data-protection authority."
  );
  return out;
}

/** Pure: config + state → markdown. */
export function renderPrivacyPolicy(
  config: PrivacyConfigInput,
  state: ReadyNativeState | undefined,
  opts: RenderPrivacyOptions = {}
): string {
  const rows: DataSafetyRow[] = state?.modules?.privacy?.dataSafety ?? [];
  const f = privacyFacts(config, state?.selection ?? {});
  const owner = opts.owner ?? PLACEHOLDER_OWNER;
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const name = config.app.name;
  const support =
    config.urls?.support && config.urls.support !== "mailto:"
      ? config.urls.support
      : "[YOUR SUPPORT EMAIL OR FORM]";

  const processors = rows.length
    ? [
        "| Service | What it receives | Their disclosure |",
        "| --- | --- | --- |",
        ...rows.map(
          (r) => `| ${r.sdk} | ${r.collects.join("; ")} | [${r.sharedWith}](${r.disclosureUrl}) |`
        ),
      ].join("\n")
    : "_No third-party service is configured in this build._";

  const tracking = f.tracking
    ? 'We do not sell personal information. With your permission - on iOS through the App Tracking Transparency prompt - we link your data with other companies\' data, for example to measure which ads bring people to the app; California law may treat this as "sharing" for cross-context behavioural advertising. Declining the prompt changes nothing about the app' +
      (f.doNotSell
        ? ', and Settings → Privacy → "Do not sell or share my personal information" turns it off.'
        : ".")
    : "We do not sell personal information and we do not share it for cross-context behavioural advertising. We do not track you across other companies' apps or websites and do not collect advertising ids.";

  const transfers = rows.length
    ? `The services above may process data outside your country, including in the United States. Where EU/UK law applies we rely on [CONFIRM: the EU-US Data Privacy Framework and/or the European Commission's Standard Contractual Clauses] with each of them.`
    : "The app sends no personal data to third-party services, so none is transferred abroad by them.";

  return `# Privacy Policy - ${name}

_Last updated: ${date}_

> **Draft generated by \`bun run gen:privacy\` from the modules this build ships.** It describes what the app does today; review it with a lawyer, replace every \`[…]\` placeholder, and re-run after you add or remove a module. Not legal advice.

## Who we are

${name} is provided by ${owner}. Questions about this policy or your data: ${support}.

## What we collect and why

${bullet(whatWeCollect(f))}

${tracking}

## Legal basis

${bullet(legalBasis(f))}

## Services that process data for us

${processors}
${rows.length ? "\nEach service acts as a processor under our instructions and its own privacy terms (linked above).\n" : ""}
## International transfers

${transfers}

## How long we keep it

${bullet(retention(f))}

## Your choices and rights

${bullet(yourChoices(f))}

## Children

${name} is not directed at children under 16 and we do not knowingly collect their data.

## Changes

We will post changes here and update the date above.${f.consentSheet ? " If a change needs your consent again, the app asks you again." : ""}
`;
}

export function loadStateForPrivacy(root: string): ReadyNativeState | undefined {
  const file = path.join(root, ".readynative.json");
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as ReadyNativeState;
}

/** Write `docs/privacy-policy.md`; returns the root-relative path. */
export function writePrivacyPolicy(root: string, markdown: string): string {
  const abs = path.join(root, PRIVACY_POLICY_REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, markdown);
  return PRIVACY_POLICY_REL;
}
