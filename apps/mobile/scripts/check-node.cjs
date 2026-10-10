/**
 * node scripts/check-node.cjs
 *
 * Runs before `setup` and `doctor` (see package.json). Everything in scripts/ is TypeScript
 * that node runs directly, which needs Node 22.18+ (native type stripping); an older node
 * fails with a syntax error that says nothing useful. This file is plain CommonJS on
 * purpose, so it parses on any node version and can say what is wrong instead.
 */
"use strict";

const MIN = [22, 18];

const parts = process.versions.node.split(".");
const major = Number(parts[0]);
const minor = Number(parts[1]);

if (major < MIN[0] || (major === MIN[0] && minor < MIN[1])) {
  console.error(
    "ReadyNative needs Node ≥ " +
      MIN.join(".") +
      " (you have v" +
      process.versions.node +
      ").\n" +
      "Install Node 24 LTS from https://nodejs.org (or `nvm install 24`), then run this again."
  );
  process.exit(1);
}
