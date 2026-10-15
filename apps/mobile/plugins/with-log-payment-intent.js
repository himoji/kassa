/**
 * KassaLite "Log Payment in Kassa" App Intent (config plugin; docs/KASSALITE.md, "Shortcut setup").
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
const { IOSConfig, withDangerousMod, withXcodeProject } = require("expo/config-plugins");

const FILE = "LogPaymentIntent.swift";
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

module.exports = function withLogPaymentIntent(config) {
  return withIntentSource(withIntentFile(config));
};
