#!/usr/bin/env bun
/*
 * `bun run seed`: reset the database to the demo seed (fixtures/seed-data.ts, Track D; inline fallback
 * if absent) and set the demo clock to seed time. Destructive: truncates every table.
 */
import { closeDb, getDb, migrateDatabaseUrl } from "../src/db/client.ts";
import { loadSeedData, seedDatabase } from "../src/modules/demo/seed.ts";

// Idempotent: makes `bun run seed` work on a brand-new PGlite directory.
await migrateDatabaseUrl();
const data = await loadSeedData();
const { userId, personaUserIds } = await seedDatabase(getDb(), data, { reset: true, personas: true });
console.log(`seeded user ${userId} (${data.user.displayName}) + ${personaUserIds.length} persona(s); demo clock = ${data.seedNow}`);
await closeDb();
