// Root ESLint flat config for the Node workspaces (apps/api, apps/mock-world, packages/shared).
// apps/mobile keeps its own eslint.config.js (expo lint) and is ignored here.
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

// Spec §4 / invariant I1: the agent has no payment capability.
const AGENT_RESTRICTED = {
  patterns: [
    {
      regex: "(^|/)payments(/|$)",
      message: "I1: agent/** must not import payments/** (spec §4). Propose via rules.decide instead.",
    },
    {
      regex: "(^|/)rails(/|$)",
      message: "I1: agent/** must not import rails/** (spec §4).",
    },
    {
      regex: "(^|/)ledger/internal(/|\\.[cm]?[jt]s$|$)",
      message: "I1: agent/** must not import ledger/internal (spec §4).",
    },
  ],
};

// Spec §4 / invariant I2: payments verifies independently; from rules it may import only rules/publicKey.
const PAYMENTS_RESTRICTED = {
  patterns: [
    {
      regex: "(^|/)rules(/(?!publicKey(\\.[cm]?[jt]s)?$).*)?$",
      message: "I2: payments/** may import only rules/publicKey from rules (spec §4).",
    },
  ],
};

// no-restricted-imports does not see dynamic import() or require(); mirror the same patterns there.
function dynamicImportBans(restricted) {
  return restricted.patterns.flatMap(({ regex, message }) => {
    const re = `/${regex.replaceAll("/", "\\/")}/u`;
    return [
      { selector: `ImportExpression[source.value=${re}]`, message },
      { selector: `CallExpression[callee.name='require'][arguments.0.value=${re}]`, message },
    ];
  });
}

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.turbo/**",
      "apps/mobile/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // @kassa/shared also runs in Hermes / the browser (apps/mobile): no Node-only globals or modules in src.
    files: ["packages/shared/src/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", { name: "Buffer", message: "Not available in React Native; use Uint8Array." }],
      "no-restricted-imports": ["error", { patterns: [{ regex: "^node:", message: "shared/src must stay runtime-agnostic." }] }],
    },
  },
  {
    files: ["apps/api/src/modules/agent/**/*.{ts,tsx,js}"],
    rules: {
      "no-restricted-imports": ["error", AGENT_RESTRICTED],
      "no-restricted-syntax": ["error", ...dynamicImportBans(AGENT_RESTRICTED)],
    },
  },
  {
    files: ["apps/api/src/modules/payments/**/*.{ts,tsx,js}"],
    rules: {
      "no-restricted-imports": ["error", PAYMENTS_RESTRICTED],
      "no-restricted-syntax": ["error", ...dynamicImportBans(PAYMENTS_RESTRICTED)],
    },
  },
);
