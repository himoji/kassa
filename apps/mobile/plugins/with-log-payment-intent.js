/**
 * KassaLite "Log Payment in Kassa" App Intent (config plugin; docs/guide/kassalite.md, "Shortcut setup").
 *
 * Copies `log-payment-intent/LogPaymentIntent.swift` into the iOS app folder and adds it to the app target's
 * sources. It goes into the app target, not a local Expo module: Xcode's "Extract App Intents Metadata" step only
 * reads the app's own Swift module, so an intent compiled into a pod never shows up in Shortcuts. App Intents need
 * no entitlement, which keeps the build signable with a free Personal Team. Applied to the lite variant only (the
 * intent reads the Keychain item src/lite/intent-config.ts writes).
 */
/* global __dirname */
const fs = require("node:fs");
const path = require("node:path");
const {
  IOSConfig,
  withDangerousMod,
  withInfoPlist,
  withXcodeProject,
} = require("expo/config-plugins");

const FILE = "LogPaymentIntent.swift";
/**
 * A URL scheme only builds with the action declare (and may query): the JS bundle, which can arrive over the air on
 * an older build, asks `Linking.canOpenURL` before it offers the action (src/lite/intent-config.ts).
 */
const MARKER_SCHEME = "kassalite-log-payment";
const SOURCE = path.join(__dirname, "log-payment-intent", FILE);

function withIntentFile(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const projectName = IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot);
      const dest = path.join(cfg.modRequest.platformProjectRoot, projectName, FILE);
      fs.copyFileSync(SOURCE, dest);
      return cfg;
    },
  ]);
}

function withIntentSource(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const projectName = IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot);
    const filepath = `${projectName}/${FILE}`;
    if (!project.hasFile(filepath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({ filepath, groupName: projectName, project });
    }
    return cfg;
  });
}

function withMarkerScheme(config) {
  return withInfoPlist(config, (cfg) => {
    const plist = cfg.modResults;
    const types = plist.CFBundleURLTypes ?? [];
    if (!types.some((t) => (t.CFBundleURLSchemes ?? []).includes(MARKER_SCHEME))) {
      types.push({ CFBundleURLSchemes: [MARKER_SCHEME] });
    }
    plist.CFBundleURLTypes = types;
    const queries = plist.LSApplicationQueriesSchemes ?? [];
    if (!queries.includes(MARKER_SCHEME)) queries.push(MARKER_SCHEME);
    plist.LSApplicationQueriesSchemes = queries;
    return cfg;
  });
}

module.exports = function withLogPaymentIntent(config) {
  return withMarkerScheme(withIntentSource(withIntentFile(config)));
};
module.exports.MARKER_SCHEME = MARKER_SCHEME;
