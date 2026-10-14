#!/usr/bin/env bun
/**
 * `bun run ota <target> [message] [-- extra eas update flags]` - publish the current JS and assets of apps/mobile as an
 * over-the-air update (EAS Update) to phones that already have a build with the update client (docs/OTA_UPDATES.md).
 *
 *   bun run ota lite "Fix activity list"          KassaLite (Xcode build, channel `lite`, iOS only)
 *   bun run ota production "Fix activity list"    full app built by `eas build --profile production`
 *   bun run ota preview                           full app built by `eas build --profile preview`
 *
 * Each target sets the same APP_VARIANT the build used, so the bundle has the right routes (lite: src/app-lite and
 * the passkey / Stripe stubs in metro.config.js). Only phones on the same channel AND runtime version (the app
 * version in apps/mobile/package.json, `runtimeVersion.policy: appVersion`) get the update. A change to native code
 * or native config (a new native module, a plugin, Info.plist, entitlements, the app version) needs a new build.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import mobileConfig from "../apps/mobile/readynative.config.ts";

type Target = { variant: string; channel: string; platform: "ios" | "android" | "all" };

const TARGETS: Record<string, Target> = {
  lite: { variant: "lite", channel: "lite", platform: "ios" },
  production: { variant: "prod", channel: "production", platform: "all" },
  preview: { variant: "preview", channel: "preview", platform: "all" },
};

const mobile = join(import.meta.dir, "../apps/mobile");
const dashDash = process.argv.indexOf("--");
const args = dashDash === -1 ? process.argv.slice(2) : process.argv.slice(2, dashDash);
const extra = dashDash === -1 ? [] : process.argv.slice(dashDash + 1);
const [name, ...messageWords] = args;
const target = name ? TARGETS[name] : undefined;

if (!target) {
  console.error(`Usage: bun run ota <${Object.keys(TARGETS).join("|")}> [message] [-- eas update flags]`);
  process.exit(1);
}

const projectId = (process.env.EAS_PROJECT_ID ?? mobileConfig.app.easProjectId ?? "").trim();
if (!projectId) {
  console.error(
    "No EAS project id. Run `npx eas-cli@latest init` in apps/mobile once and paste the id it prints into\n" +
      "apps/mobile/readynative.config.ts (app.easProjectId), or set EAS_PROJECT_ID. Then rebuild the app once\n" +
      "so the installed build knows where to look for updates (docs/OTA_UPDATES.md)."
  );
  process.exit(1);
}

const message = messageWords.join(" ").trim() || `${name} update ${new Date().toISOString()}`;
const easArgs = [
  "eas-cli@latest",
  "update",
  "--channel",
  target.channel,
  "--platform",
  target.platform,
  "--message",
  message,
  ...extra,
];

console.log(`\n$ APP_VARIANT=${target.variant} npx ${easArgs.join(" ")}   (in ${mobile})`);
const result = spawnSync("npx", easArgs, {
  cwd: mobile,
  stdio: "inherit",
  env: {
    ...process.env,
    APP_VARIANT: target.variant,
    EXPO_PUBLIC_APP_VARIANT: target.variant,
  },
});
process.exit(result.status ?? 1);
