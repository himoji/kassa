#!/usr/bin/env bun
/**
 * `bun run lite:ios` - generate the KassaLite iOS project into apps/mobile/ios-lite (docs/KASSALITE.md).
 *
 * KassaLite is a build of apps/mobile signed with a free Apple ID (Personal Team): APP_VARIANT=lite gives it
 * its own bundle id, routes (src/app-lite) and a native config without push / associated domains / Apple Pay.
 *
 * 1. Temporarily writes `expo.autolinking.exclude` (react-native-passkeys, @stripe/stripe-react-native) into
 *    apps/mobile/package.json. Expo reads that list only from package.json, not from app.config.ts, and the
 *    exclusion must not leak into the full app, so the file is restored afterwards (also on Ctrl-C or failure).
 * 2. `APP_VARIANT=lite expo prebuild --clean -p ios --no-install`. Prebuild always writes to ios/, so an existing
 *    apps/mobile/ios is moved aside for the run and put back afterwards.
 * 3. Moves the result to apps/mobile/ios-lite, runs `pod install` there (macOS, with the same exclude list) and
 *    pins APP_VARIANT=lite in ios-lite/.xcode.env.local so Xcode's "Bundle React Native code" phase bundles the
 *    lite routes.
 * 4. On macOS opens the .xcworkspace and prints what to do in Xcode.
 *
 * Flags: --no-open (do not open Xcode).
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const mobile = join(root, "apps/mobile");
const packageJsonPath = join(mobile, "package.json");
const iosDir = join(mobile, "ios");
const iosBackup = join(mobile, "ios.before-lite");
const liteDir = join(mobile, "ios-lite");
const noOpen = process.argv.includes("--no-open");
const isMac = process.platform === "darwin";

/** Native modules the lite build must not link (free team: no passkeys / Associated Domains, no payments). */
const EXCLUDE = ["react-native-passkeys", "@stripe/stripe-react-native"];

const env = { ...process.env, APP_VARIANT: "lite" };

function run(cmd: string, args: string[], cwd: string): void {
  console.log(`\n$ ${cmd} ${args.join(" ")}   (in ${cwd})`);
  const result = spawnSync(cmd, args, { cwd, env, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${result.status})`);
}

const originalPackageJson = readFileSync(packageJsonPath, "utf8");
let restored = false;
function restorePackageJson(): void {
  if (restored) return;
  restored = true;
  writeFileSync(packageJsonPath, originalPackageJson);
}
process.on("SIGINT", () => {
  restorePackageJson();
  process.exit(130);
});

function writeExclude(): void {
  const pkg = JSON.parse(originalPackageJson) as {
    expo?: { autolinking?: { exclude?: string[] } };
  };
  pkg.expo ??= {};
  pkg.expo.autolinking ??= {};
  pkg.expo.autolinking.exclude = [
    ...new Set([...(pkg.expo.autolinking.exclude ?? []), ...EXCLUDE]),
  ];
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

let movedIos = false;
try {
  writeExclude();

  if (existsSync(iosBackup)) {
    throw new Error(
      `${iosBackup} exists (an earlier run was interrupted). Move it back to ios/ or delete it.`,
    );
  }
  if (existsSync(iosDir)) {
    renameSync(iosDir, iosBackup);
    movedIos = true;
  }

  try {
    run(
      "bunx",
      ["expo", "prebuild", "--clean", "-p", "ios", "--no-install"],
      mobile,
    );
    rmSync(liteDir, { recursive: true, force: true });
    renameSync(iosDir, liteDir);
  } finally {
    if (movedIos && existsSync(iosBackup)) {
      rmSync(iosDir, { recursive: true, force: true });
      renameSync(iosBackup, iosDir);
    }
  }

  // expo-notifications still writes `aps-environment` (remote push) even with its plugin dropped; a Personal Team
  // cannot sign it ("do not support the Push Notifications capability"), so strip it. Local notifications keep working.
  for (const dir of readdirSync(liteDir)) {
    const file = join(liteDir, dir, `${dir}.entitlements`);
    if (!existsSync(file)) continue;
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        /\s*<key>aps-environment<\/key>\s*<string>[^<]*<\/string>/,
        "",
      ),
    );
  }

  if (isMac) run("pod", ["install"], liteDir);
  else
    console.log(
      "\nNot macOS: skipping `pod install`. Run it in apps/mobile/ios-lite on the Mac.",
    );

  // Xcode's bundling phase reads .xcode.env.local; without APP_VARIANT it would bundle the full app's routes.
  const envLocal = join(liteDir, ".xcode.env.local");
  const existing = existsSync(envLocal) ? readFileSync(envLocal, "utf8") : "";
  if (!existing.includes("APP_VARIANT")) {
    appendFileSync(
      envLocal,
      `${existing.endsWith("\n") || !existing ? "" : "\n"}export APP_VARIANT=lite\n`,
    );
  }

  // Run (Cmd-R) in Release:  the JS is bundled with the lite stubs. A Debug binary loads JS from whatever Metro
  // is on :8081, usually dev:all's full-app Metro, and then crashes on the missing StripeSdk native module.
  const schemes = join(liteDir, "KassaLite.xcodeproj/xcshareddata/xcschemes");
  if (existsSync(schemes)) {
    for (const f of readdirSync(schemes).filter((n) =>
      n.endsWith(".xcscheme"),
    )) {
      const file = join(schemes, f);
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(
          /(<LaunchAction\s+buildConfiguration = )"Debug"/,
          '$1"Release"',
        ),
      );
    }
  }
} finally {
  restorePackageJson();
}

const workspace = existsSync(liteDir)
  ? readdirSync(liteDir).find((f) => f.endsWith(".xcworkspace"))
  : undefined;

if (isMac && workspace && !noOpen) {
  spawnSync("open", [join(liteDir, workspace)], { stdio: "inherit" });
}

console.log(`
KassaLite iOS project: ${liteDir}${workspace ? `\nWorkspace: ${join(liteDir, workspace)}` : ""}

In Xcode:
  1. Select the KassaLite target > Signing & Capabilities > Team: your Apple ID ("Personal Team").
     If "app.kassa.lite" is taken, change the Bundle Identifier (e.g. app.kassa.lite.<yourname>).
  2. Pick your iPhone (Developer Mode on: Settings > Privacy & Security > Developer Mode).
  3. Run (Cmd-R). The scheme already runs Release (JS bundled, no Metro needed).
  4. On the iPhone: Settings > General > VPN & Device Management > trust your developer certificate.
A free profile expires after 7 days: run again from Xcode weekly.

For a Debug build start Metro with:  APP_VARIANT=lite bunx expo start (from apps/mobile)
Full guide: docs/KASSALITE.md
`);
