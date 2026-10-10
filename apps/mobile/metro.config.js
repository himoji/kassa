// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// expo-sqlite on web ships its engine as a .wasm asset.
config.resolver.assetExts.push("wasm");

module.exports = withNativeWind(config, { input: "./src/global.css", inlineRem: 16 });
