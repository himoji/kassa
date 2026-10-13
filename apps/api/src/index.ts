/* API entry point: env check, clock load, Fastify server, 15 s scheduler (spec §15). */
import { closeDb, migrateDatabaseUrl } from "./db/client.ts";
import { env } from "./env.ts";
import { clock } from "./modules/clock/index.ts";
import { startScheduler } from "./modules/scheduler/index.ts";
import { buildServer } from "./server.ts";

const e = env();
// Dev convenience: apply migrations on start unless production (AUTO_MIGRATE=false opts out; =true forces it).
const autoMigrate = process.env.AUTO_MIGRATE ?? (e.NODE_ENV === "production" ? "false" : "true");
if (autoMigrate === "true" || autoMigrate === "1") {
  console.log(`auto-migrate: migrations applied (${await migrateDatabaseUrl()})`);
}
const app = await buildServer();
await clock.load().catch((err: unknown) => app.log.warn({ err }, "demo_state not readable yet (run bun run db:migrate)"));
const stop = e.SCHEDULER_ENABLED ? startScheduler((msg, err) => app.log.error({ err }, msg)) : () => undefined;

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  stop();
  await app.close();
  await closeDb();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: e.PORT, host: e.HOST });
