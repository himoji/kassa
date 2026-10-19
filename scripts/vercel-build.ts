#!/usr/bin/env bun
/*
 * `bun run vercel-build`: Vercel's build command (vercel.json).
 * 1. Applies the drizzle migrations to DATABASE_URL (Postgres) on production builds, or on any build with
 *    MIGRATE_ON_BUILD=true. Preview builds skip it unless they have their own database.
 * 2. Exports the web app to apps/mobile/dist (vercel.json `outputDirectory`). Leave EXPO_PUBLIC_API_URL unset:
 *    the web app then calls /api on its own origin, where the Vercel Function serves it.
 * 3. Builds the documentation site (docs/, VitePress) into apps/mobile/dist/docs, served at /docs. A docs failure
 *    never fails the app deploy.
 */
import { $ } from "bun";

const db = process.env.DATABASE_URL ?? "";
const migrate = process.env.MIGRATE_ON_BUILD ?? (process.env.VERCEL_ENV === "production" ? "true" : "false");
if (migrate === "true" || migrate === "1") {
  if (!/^postgres(ql)?:\/\//.test(db)) {
    console.error("vercel-build: DATABASE_URL must be a postgres:// URL (add a Postgres database to the Vercel project)");
    process.exit(1);
  }
  await $`bun run --cwd apps/api db:migrate`;
} else {
  console.log("vercel-build: skipping migrations (set MIGRATE_ON_BUILD=true to run them on this build)");
}

await $`bun run --cwd apps/mobile build`;

try {
  await $`bun run docs:build`.env({ ...process.env, DOCS_BASE: "/docs/" });
  await $`rm -rf apps/mobile/dist/docs && cp -R docs/.vitepress/dist apps/mobile/dist/docs`;
  console.log("vercel-build: docs at /docs");
} catch (err) {
  console.error("vercel-build: docs build failed, deploying without /docs", err);
}
