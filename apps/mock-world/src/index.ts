// Mock world entry point (spec §17). Everything served here is simulated.
import { buildMockWorld } from "./app.ts";
import { loadConfig, usingDevSecret } from "./config.ts";

const config = loadConfig();
const { app } = await buildMockWorld({ config });
if (usingDevSecret(config)) app.log.warn("MOCK_HMAC_SECRET not set: using the dev-only secret (set it to match the API)");

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
