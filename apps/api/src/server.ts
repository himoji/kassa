/*
 * Fastify 5 server (spec §8). Every route lives under /api. Track A plugins are imported statically;
 * Track B plugins (src/modules/{agent,onboarding,capture,budget,fx}/routes.ts) are loaded dynamically and
 * skipped when the file does not exist yet, so a missing module never crashes the API.
 * Errors are RFC 9457 problem+json (http/problem.ts).
 */
import fastifyCookie from "@fastify/cookie";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { hasZodFastifySchemaValidationErrors, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { env } from "./env.ts";
import { HttpProblem, problemBody } from "./http/problem.ts";
import authRoutes from "./modules/auth/routes.ts";
import creditRecordRoutes from "./modules/credit-record/routes.ts";
import demoRoutes from "./modules/demo/routes.ts";
import ledgerRoutes from "./modules/ledger/routes.ts";
import mandateRoutes from "./modules/mandates/routes.ts";
import moneyRoutes from "./modules/money/routes.ts";
import notificationRoutes from "./modules/notifications/routes.ts";
import orderRoutes from "./modules/orders/routes.ts";
import { wireExecutor } from "./modules/orders/wiring.ts";
import payeeRoutes from "./modules/payees/routes.ts";
import paymentRoutes from "./modules/payments/routes.ts";
import userRoutes from "./modules/users/routes.ts";
import webhookRoutes from "./modules/webhooks/routes.ts";

/** Track B route plugins (coordination doc), mounted under /api when present. */
export const OPTIONAL_PLUGINS = ["agent", "onboarding", "capture", "budget", "fx"] as const;

async function loadOptionalPlugin(name: string, log: FastifyInstance["log"]): Promise<FastifyPluginAsync | null> {
  const url = new URL(`./modules/${name}/routes.ts`, import.meta.url);
  if (!existsSync(fileURLToPath(url))) {
    log.warn({ plugin: name }, "optional route plugin not present yet; skipped");
    return null;
  }
  // A present-but-broken plugin is a real error: let it throw.
  const mod = (await import(/* @vite-ignore */ url.href)) as { default?: FastifyPluginAsync };
  if (typeof mod.default !== "function") {
    log.warn({ plugin: name }, "optional route plugin has no default export; skipped");
    return null;
  }
  return mod.default;
}

export async function buildServer(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const e = env();
  const app = Fastify({
    logger: opts.logger ?? e.NODE_ENV !== "test",
    // Body size: invoices/screenshots go through B's upload route; JSON elsewhere stays small.
    bodyLimit: 12 * 1024 * 1024,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(fastifyCookie);

  app.setErrorHandler((err: FastifyError | HttpProblem | Error, req, reply) => {
    const instance = req.url;
    if (err instanceof HttpProblem) {
      return reply
        .status(err.status)
        .type("application/problem+json")
        .send(problemBody(err.status, err.code, err.message, instance, { reasonCodes: err.reasonCodes, details: err.details }));
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply
        .status(400)
        .type("application/problem+json")
        .send(problemBody(400, "VALIDATION_FAILED", "Request does not match the schema", instance, { details: err.validation }));
    }
    const status = (err as FastifyError).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return reply.status(status).type("application/problem+json").send(problemBody(status, (err as FastifyError).code, err.message, instance));
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).type("application/problem+json").send(problemBody(500, "INTERNAL", "Internal error", instance));
  });
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).type("application/problem+json").send(problemBody(404, "NOT_FOUND", `No route ${req.method} ${req.url}`, req.url)),
  );

  wireExecutor();

  await app.register(
    async (api) => {
      api.get("/health", async () => ({ ok: true, service: "api" }));
      await api.register(authRoutes);
      await api.register(userRoutes);
      await api.register(payeeRoutes);
      await api.register(mandateRoutes);
      await api.register(orderRoutes);
      await api.register(paymentRoutes);
      await api.register(moneyRoutes);
      await api.register(notificationRoutes);
      await api.register(ledgerRoutes);
      await api.register(creditRecordRoutes);
      await api.register(webhookRoutes);
      await api.register(demoRoutes);
      for (const name of OPTIONAL_PLUGINS) {
        const plugin = await loadOptionalPlugin(name, app.log);
        if (plugin) await api.register(plugin);
      }
    },
    { prefix: "/api" },
  );
  return app;
}
