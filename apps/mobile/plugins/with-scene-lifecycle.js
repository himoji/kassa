/**
 * iOS 27 scene life cycle (config plugin).
 *
 * Apps built with the iOS 27 SDK trap at launch
 * (`_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`) unless they
 * adopt `UIScene`. Expo ships `ExpoAppSceneDelegate` for this, but the SDK 57
 * prebuild template still starts React Native from the app delegate, so this
 * plugin:
 *  - declares the scene manifest in Info.plist with `EXExpoAppSceneDelegate`;
 *  - makes `AppDelegate` an `ExpoReactNativeFactoryProvider` and leaves window
 *    creation + `startReactNative` to the scene delegate.
 * Drop it once `expo prebuild` generates this itself.
 */
const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

const START_BLOCK =
  /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([\s\S]*?\)\n#endif\n/;

function withSceneManifest(config) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "EXExpoAppSceneDelegate",
          },
        ],
      },
    };
    return cfg;
  });
}

function withSceneAppDelegate(config) {
  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== "swift") {
      throw new Error("with-scene-lifecycle: expected a Swift AppDelegate");
    }
    let src = cfg.modResults.contents;
    if (src.includes("ExpoReactNativeFactoryProvider")) return cfg;
    src = src.replace(
      "class AppDelegate: ExpoAppDelegate {",
      "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {"
    );
    if (!START_BLOCK.test(src)) {
      throw new Error("with-scene-lifecycle: AppDelegate template changed; update the plugin");
    }
    src = src.replace(
      START_BLOCK,
      "\n    // The window and startReactNative live in ExpoAppSceneDelegate (UIScene life cycle).\n"
    );
    cfg.modResults.contents = src;
    return cfg;
  });
}

module.exports = function withSceneLifecycle(config) {
  return withSceneAppDelegate(withSceneManifest(config));
};
