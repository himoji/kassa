#!/usr/bin/env bun
/*
 * `bun run vercel-build`: Vercel's build command (vercel.json).
 * 1. Applies the drizzle migrations to DATABASE_URL (Postgres) on production builds, or on any build with
 *    MIGRATE_ON_BUILD=true. Preview builds skip it unless they have their own database.
 * 2. Exports the web app to apps/mobile/dist (vercel.json `outputDirectory`). Leave EXPO_PUBLIC_API_URL unset:
 *    the web app then calls /api on its own origin, where the Vercel Function serves it.
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
