#!/usr/bin/env bun
/* `bun run db:migrate`: apply drizzle/ migrations to DATABASE_URL (unset → file-backed PGlite in .data/kassa). */
import { migrateDatabaseUrl } from "../src/db/client.ts";

const where = await migrateDatabaseUrl();
console.log(`migrations applied (${where})`);
