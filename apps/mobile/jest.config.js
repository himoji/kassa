/** @type {import('jest').Config} */
module.exports = {
  preset: "jest-expo",
  resolver: "react-native-worklets/jest/resolver",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  // @noble/hashes and canonicalize (deps of @kassa/shared) ship ESM only; marked and github-slugger
  // (deps of react-native-marked) do too.
  transformIgnorePatterns: [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|nativewind|react-native-css|standard-navigation|@rn-primitives/.*|@expo/vector-icons|tamagui|@tamagui/.*|@noble/hashes|canonicalize|marked|github-slugger)",
  ],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  testPathIgnorePatterns: [
    "<rootDir>/ios/",
    "<rootDir>/android/",
    "<rootDir>/node_modules/",
    "<rootDir>/.expo/",
    // modules/**/files mirrors src/ and is copied in by `bun setup`; never run it in place.
    "<rootDir>/modules/",
    // examples/* are standalone apps with their own jest config; run their tests from inside them.
    "<rootDir>/examples/",
    // tools/* are standalone packages with their own test runner.
    "<rootDir>/tools/",
    // .claude/ holds agent worktrees, which are full copies of this repo.
    "<rootDir>/.claude/",
  ],
  modulePathIgnorePatterns: ["<rootDir>/modules/", "<rootDir>/examples/", "<rootDir>/.claude/"],
};
