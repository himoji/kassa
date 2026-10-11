import type { FastifyInstance } from "fastify";
import Fastify from "fastify";

import { balances, IDS, MOCK_BANK_PROFILE_ID } from "../../../fixtures/seed-data.ts";
import { BankError, MockBank } from "./bank/bank.ts";
import { ApiRates, type RateProvider } from "./bank/rates.ts";
import type { Clock, FetchLike } from "./clock.ts";
import { DemoClock } from "./clock.ts";
import type { MockWorldConfig } from "./config.ts";
import { HttpError } from "./errors.ts";
import { esc, page } from "./html.ts";
import { renderInvoice } from "./pdf/invoice.ts";
import { renderPriceList } from "./pdf/priceList.ts";
import { QrWallet } from "./qr/qr.ts";
import { bankRoutes } from "./routes/bank.ts";
import { type DocumentCache, documentRoutes } from "./routes/documents.ts";
import { eventRoutes } from "./routes/events.ts";
import { qrRoutes } from "./routes/qr.ts";
import { ChargeLog, shopRoutes } from "./routes/shop.ts";
import { FakeIssuerClient, type Issuer, StripeTestHelperClient } from "./shop/issuer.ts";
import { type OutboxEntry, WebhookClient, type WebhookSink } from "./webhooks.ts";
import { PAYEE_INVOICES, SUPPLIERS } from "./world/data.ts";

/*
 * Mock world (spec §17): one Fastify 5 app, every route under the /mock prefix (Caddy forwards
 * /mock* unchanged). Dependencies are injectable so tests run without network or timers.
 */

export interface AppDeps {
  config: MockWorldConfig;
  clock?: Clock;
  fetch?: FetchLike;
  webhooks?: WebhookSink & { outbox?: OutboxEntry[] };
  rates?: RateProvider;
  issuer?: Issuer;
  /** Fastify logger; false in tests. */
  logger?: boolean | { level: string };
  /** Start the background tick that advances bank transfers on the demo clock. Default true. */
  startTicker?: boolean;
}

export interface MockWorld {
  app: FastifyInstance;
  bank: MockBank;
  qr: QrWallet;
  webhooks: WebhookSink & { outbox?: OutboxEntry[] };
  clock: Clock;
}

async function renderDocuments(): Promise<DocumentCache> {
  const invoices: Record<string, Uint8Array> = {};
  for (const [id, spec] of Object.entries(PAYEE_INVOICES)) invoices[id] = (await renderInvoice(spec)).pdf;
  return {
    priceLists: { a: await renderPriceList(SUPPLIERS.a), b: await renderPriceList(SUPPLIERS.b) },
    invoices,
  };
}

export async function buildMockWorld(deps: AppDeps): Promise<MockWorld> {
  const { config } = deps;
  const app = Fastify({ logger: deps.logger ?? { level: config.logLevel } });
  const log = (msg: string, data?: Record<string, unknown>) => app.log.warn(data ?? {}, msg);

  const clock =
    deps.clock ??
    new DemoClock(config.apiUrl, {
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      onFallback: (err) => log("demo clock unreachable; using real time / last known offset", { error: String(err) }),
    });
  const webhooks =
    deps.webhooks ??
    new WebhookClient({ apiUrl: config.apiUrl, secret: config.hmacSecret, clock, log, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const rates = deps.rates ?? new ApiRates(config.apiUrl, deps.fetch ? { fetch: deps.fetch } : {});
  const bank = new MockBank({
    clock,
    rates,
    webhooks,
    stepMs: config.bankStepMs,
    initialBalances: [{ profileId: MOCK_BANK_PROFILE_ID, aliases: [IDS.user], balances }],
  });
  const qr = new QrWallet({ clock, webhooks, publicUrl: config.publicUrl });
  const issuer =
    deps.issuer ??
    (config.issuingProvider === "stripe"
      ? new StripeTestHelperClient({ secretKey: config.stripeSecretKey!, apiBase: config.stripeApiBase, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
      : new FakeIssuerClient({ apiUrl: config.apiUrl, secret: config.hmacSecret, clock, ...(deps.fetch ? { fetch: deps.fetch } : {}) }));
  const charges = new ChargeLog();
  const docs = await renderDocuments();

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof BankError) {
      // Wise error shape plus the shared ApiError fields.
      return reply.code(err.status).send({
        ...(err.body ?? {}),
        errors: [{ code: err.code, message: err.message, ...(err.path ? { path: err.path } : {}) }],
        error: err.message,
        code: err.code,
      });
    }
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500) {
      // Fastify's own client errors (bad JSON, unsupported media type, body too large).
      return reply.code(e.statusCode).send({ error: e.message ?? "Bad request", code: e.code ?? "BAD_REQUEST" });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "Internal error", code: "INTERNAL" });
  });

  await app.register(
    async (r) => {
      r.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found", code: "NOT_FOUND" }));

      r.get("/health", async () => ({
        ok: true,
        service: "mock-world",
        simulated: true,
        issuingProvider: issuer.provider,
        clockSource: clock instanceof DemoClock ? clock.source : "injected",
        now: (await clock.now()).toISOString(),
      }));

      // Demo reset (the API's POST /demo/reset should call this too).
      r.post("/reset", async () => {
        bank.reset();
        qr.reset();
        charges.reset();
        return { ok: true, simulated: true };
      });

      // Webhook delivery log: evidence for docs/evidence (spec §19 "mock-bank transfer logs").
      r.get("/outbox", async () => ({ entries: webhooks.outbox ?? [], simulated: true }));

      r.get("/", async (_req, reply) => {
        const links: [string, string][] = [
          ["Pizza Shop in Budapest", "/mock/shop/pizza"],
          ["Pizza Shop in Budapest menu (JSON)", "/mock/shop/pizza/menu"],
          ["Supplier A catalog", "/mock/suppliers/a/catalog"],
          ["Supplier B catalog", "/mock/suppliers/b/catalog"],
          ["Supplier A price list (PDF)", "/mock/suppliers/a/price-list.pdf"],
          ["Supplier B price list (PDF)", "/mock/suppliers/b/price-list.pdf"],
          ["Tuition invoice (PDF)", "/mock/payees/university/invoice.pdf"],
          ["Tuition invoice, swapped account (PDF)", "/mock/payees/university/invoice.pdf?variant=swapped-account"],
          ["Rent invoice (PDF)", "/mock/payees/landlord/invoice.pdf"],
          ["Insurance invoice (PDF)", "/mock/payees/insurer/invoice.pdf"],
          ["Inbox (JSON)", "/mock/inbox"],
          ["Mock bank transfers (JSON)", "/mock/bank/transfers"],
          ["Webhook outbox (JSON)", "/mock/outbox"],
        ];
        const items = links.map(([t, h]) => `<li><a href="${esc(h)}">${esc(t)}</a></li>`).join("");
        return reply
          .type("text/html; charset=utf-8")
          .send(page("Mock world", `<h1>Kassa mock world</h1><p class="muted">Simulated services for the demo. Generic names, no real brands.</p><div class="card"><ul>${items}</ul></div>`));
      });

      bankRoutes(r, bank);
      shopRoutes(r, { issuer, clock, log: charges });
      documentRoutes(r, { docs, publicUrl: config.publicUrl });
      qrRoutes(r, qr);
      eventRoutes(r, { clock, webhooks, bank, defaultProfileId: MOCK_BANK_PROFILE_ID });
    },
    { prefix: "/mock" },
  );

  if (deps.startTicker !== false) {
    const timer = setInterval(() => {
      bank.tick().catch((err: unknown) => log("bank tick failed", { error: String(err) }));
    }, config.bankTickMs);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }

  return { app, bank, qr, webhooks, clock };
}
