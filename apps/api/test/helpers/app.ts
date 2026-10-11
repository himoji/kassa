/* Fastify app for HTTP-level tests (inject, no network). */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll } from "vitest";

import { mintAccessTokenForTests } from "../../src/modules/auth/session.ts";
import { buildServer } from "../../src/server.ts";

export function useTestApp(): () => FastifyInstance {
  let app: FastifyInstance | null = null;
  beforeAll(async () => {
    app = await buildServer({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
  });
  return () => {
    if (!app) throw new Error("app not ready");
    return app;
  };
}

export async function bearer(userId: string): Promise<{ authorization: string }> {
  return { authorization: `Bearer ${await mintAccessTokenForTests(userId)}` };
}
