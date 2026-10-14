// KassaLite (APP_VARIANT=lite) does not link these native modules (scripts/lite.ts, `expo.autolinking.exclude`).
// Codegen ignores that exclude list and would still register their Fabric views in
// RCTThirdPartyComponentsProvider.mm; NSClassFromString then returns nil and the app crashes at launch
// ("attempt to insert nil object from objects[0]"). `platforms.ios: null` makes codegen skip them too.
const LITE_EXCLUDE = ["react-native-passkeys", "@stripe/stripe-react-native"];

module.exports = {
  dependencies:
    process.env.APP_VARIANT === "lite"
      ? Object.fromEntries(
          LITE_EXCLUDE.map((name) => [name, { platforms: { ios: null } }]),
        )
      : {},
};
