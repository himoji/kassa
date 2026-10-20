import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    env: { NODE_ENV: "test", RP_ID: "localhost", PUBLIC_ORIGIN: "http://localhost:8081", DEMO_ENABLED: "true", COOLING_DEFAULT: "on", SCHEDULER_ENABLED: "false" },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
