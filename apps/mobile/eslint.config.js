// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");
const prettierRecommended = require("eslint-plugin-prettier/recommended");

module.exports = defineConfig([
  expoConfig,
  prettierRecommended,
  {
    // public/sw.js is a plain-JS service worker: it runs in ServiceWorkerGlobalScope, not in the app.
    files: ["public/sw.js"],
    languageOptions: {
      globals: {
        self: "readonly",
        caches: "readonly",
        clients: "readonly",
        fetch: "readonly",
        URL: "readonly",
        Response: "readonly",
        Request: "readonly",
      },
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".expo/**",
      "dist/**",
      "ios/**",
      "ios-lite/**",
      "android/**",
      "coverage/**",
      "modules/**",
      "examples/**",
    ],
  },
]);
