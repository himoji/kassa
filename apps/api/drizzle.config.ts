import { defineConfig } from "drizzle-kit";

// drizzle-kit: `bunx drizzle-kit generate` writes SQL migrations to ./drizzle from src/db/schema.ts.
export default defineConfig({
  dialect: "postgresql",
  // schema.intel.ts = Track B tables (agent messages/documents, category memory, onboarding drafts).
  schema: ["./src/db/schema.ts", "./src/db/schema.intel.ts"],
  out: "./drizzle",
  // Only `generate` is used (no DB connection needed); migrations run via scripts/migrate.ts (PGlite or Postgres).
  strict: true,
});
