module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { jsxImportSource: "nativewind" }], "nativewind/babel"],
    // scripts/lib/here.ts reads `import.meta.url` (so `node scripts/*.ts` works under
    // any package manager); jest compiles it to CommonJS, where babel-preset-expo would
    // otherwise rewrite `import.meta` to its app-only registry. Plugins run before presets.
    plugins: ["babel-plugin-transform-import-meta"],
  };
};
