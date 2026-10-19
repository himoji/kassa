// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// expo-sqlite on web ships its engine as a .wasm asset.
config.resolver.assetExts.push("wasm");

// KassaLite (APP_VARIANT=lite, docs/guide/kassalite.md): the passkey and Stripe native modules are not linked
// into that build (scripts/lite.ts excludes them from autolinking), so their JS packages are replaced
// by inert stubs. The full app and web build are untouched.
if (process.env.APP_VARIANT === "lite") {
  const path = require("node:path");
  const stubs = {
    "react-native-passkeys": path.join(__dirname, "src/lite/stubs/react-native-passkeys.ts"),
    "@stripe/stripe-react-native": path.join(__dirname, "src/lite/stubs/stripe-react-native.tsx"),
  };
  const upstream = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const stub = stubs[moduleName];
    if (stub) return { type: "sourceFile", filePath: stub };
    return (upstream ?? context.resolveRequest)(context, moduleName, platform);
  };
}

module.exports = withNativeWind(config, { input: "./src/global.css", inlineRem: 16 });
