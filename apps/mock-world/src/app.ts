import type { FastifyInstance } from "fastify";
import Fastify from "fastify";

import { balances, IDS, MOCK_BANK_PROFILE_ID, seed } from "../../../fixtures/seed-data.ts";
import { accessGuard } from "./access.ts";
import { BankError, MockBank } from "./bank/bank.ts";
import { ApiRates, type RateProvider } from "./bank/rates.ts";
import type { Clock, FetchLike } from "./clock.ts";
import { DemoClock } from "./clock.ts";
import type { MockWorldConfig } from "./config.ts";
import { HttpError } from "./errors.ts";
import { esc, page } from "./html.ts";
import { KycDesk } from "./kyc/kyc.ts";
import { renderInvoice } from "./pdf/invoice.ts";
import { renderPriceList } from "./pdf/priceList.ts";
import { QrWallet } from "./qr/qr.ts";
import { bankRoutes } from "./routes/bank.ts";
import { type DocumentCache, documentRoutes } from "./routes/documents.ts";
import { eventRoutes } from "./routes/events.ts";
import { kycRoutes } from "./routes/kyc.ts";
import { qrRoutes } from "./routes/qr.ts";
import { ChargeLog, shopRoutes } from "./routes/shop.ts";
import { shopOrderRoutes } from "./routes/shopOrders.ts";
import { stageRoutes } from "./routes/stage.ts";
import { schoolRoutes } from "./routes/schools.ts";
import { supplierPortalRoutes } from "./routes/supplierPortal.ts";
import { SchoolBook } from "./school/schools.ts";
import { SupplierBook } from "./supplier/book.ts";
import { memoryStore } from "./store/memory.ts";
import { WorldSync } from "./store/sync.ts";
import type { SeedWallet, WorldStore } from "./store/types.ts";
import { StageApi } from "./stage/client.ts";
import { FakeIssuerClient, type Issuer, StripeTestHelperClient } from "./shop/issuer.ts";
import { ShopOrderBook } from "./shop/orders.ts";
import { MemoryLeases } from "./store/leases.ts";
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
  /**
   * (added 2026-10-18) Where the state lives: in memory by default; a deployed build passes the Postgres store
   * (store/postgres.ts, api/index.ts) so every instance sees the same world. Build it with `seedWallets()`.
   */
  store?: WorldStore;
}

/** The wallets the mock bank starts with: Dana's capped wallet and the demo personas'. */
export function seedWallets(): SeedWallet[] {
  return [
    { profileId: MOCK_BANK_PROFILE_ID, aliases: [IDS.user], balances },
    // Demo personas (seeded by the API with `personas: true`: Li Wei D-CN3, Li Wei in Shanghai, the two pizzerias);
    // alias = user id and persona key, e.g. `sim mock remittance --profile li-wei`.
    ...seed.personas.map((p) => ({ profileId: p.mockBankProfileId, aliases: [p.user.id, p.persona], balances: [...p.balances] })),
  ];
}

export interface MockWorld {
  app: FastifyInstance;
  bank: MockBank;
  qr: QrWallet;
  /** (M2/M3) The pizza shops' delivery orders and till bills. */
  shop: ShopOrderBook;
  /** (M5) Suppliers' purchase orders (portal, invoices). */
  suppliers: SupplierBook;
  /** School payment portals: tuition invoices, paid from the mock bank's payouts. */
  schools: SchoolBook;
  /** (added 2026-10-16) Identity checks (KYC), simulated: outcomes only. */
  kyc: KycDesk;
  webhooks: WebhookSink & { outbox?: OutboxEntry[] };
  clock: Clock;
  /** "memory" or "postgres" (store/types.ts). */
  persistence: WorldStore["persistence"];
  /** Shares the books between instances (no-op in memory). */
  sync: WorldSync;
  /** Advance bank transfers and the shop autopilot once (with the shared state read before and written after). */
  tick(): Promise<void>;
}

async function renderDocuments(): Promise<DocumentCache> {
  const invoices: Record<string, Uint8Array> = {};
  for (const [id, spec] of Object.entries(PAYEE_INVOICES)) invoices[id] = (await renderInvoice(spec)).pdf;
  return {
    priceLists: {
      a: await renderPriceList(SUPPLIERS.a),
      b: await renderPriceList(SUPPLIERS.b),
      c: await renderPriceList(SUPPLIERS.c),
      d: await renderPriceList(SUPPLIERS.d),
    },
    invoices,
  };
}

export async function buildMockWorld(deps: AppDeps): Promise<MockWorld> {
  const { config } = deps;
  const app = Fastify({ logger: deps.logger ?? { level: config.logLevel } });
  const store = deps.store ?? memoryStore(seedWallets());
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
    instant: config.bankInstant,
    store: store.balances,
  });
  const qr = new QrWallet({ clock, webhooks, publicUrl: config.publicUrl });
  const issuer =
    deps.issuer ??
    (config.issuingProvider === "stripe"
      ? new StripeTestHelperClient({ secretKey: config.stripeSecretKey!, apiBase: config.stripeApiBase, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
      : new FakeIssuerClient({ apiUrl: config.apiUrl, secret: config.hmacSecret, clock, ...(deps.fetch ? { fetch: deps.fetch } : {}) }));
  const charges = new ChargeLog();
  const leases = store.leases ?? new MemoryLeases();
  const shop = new ShopOrderBook({ issuer, clock, log: charges, webhooks, qr, kassaAppUrl: config.kassaAppUrl, stepMs: config.shopStepMs, autopilot: config.shopAutopilot, leases });
  const suppliers = new SupplierBook({ clock, webhooks, publicUrl: config.publicUrl });
  const schools = new SchoolBook({ clock, webhooks, secret: config.hmacSecret });
  const kyc = new KycDesk({ clock });
  bank.onPayout((t, account) => schools.onPayout(t, account));
  const docs = await renderDocuments();

  const resetLocal = () => {
    bank.resetLocal();
    qr.reset();
    charges.reset();
    shop.reset();
    if (leases instanceof MemoryLeases) leases.reset();
    suppliers.reset();
    schools.reset();
    kyc.reset();
  };
  const sync = new WorldSync(
    store.entities,
    [...bank.collections(), ...qr.collections(), ...charges.collections(), ...shop.collections(), ...suppliers.collections(), ...schools.collections(), ...kyc.collections()],
    // Reset (or the API's demo reset wiped the tables) elsewhere: seeds here, and the seeded wallets if they are gone.
    async () => {
      resetLocal();
      await store.balances.seed();
    },
  );
  const resetWorld = async () => {
    resetLocal();
    await bank.reset();
    await sync.reset();
  };
  // Everything the other instances already did, before the first request.
  await sync.pull();
  const tick = () =>
    sync.around(async () => {
      for (const r of await Promise.allSettled([bank.tick(), shop.tick()])) {
        if (r.status === "rejected") log("mock world tick failed", { error: String(r.reason) });
      }
    });

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
      // Deployed builds: control routes need the Kassa API's signed request or the demo admin token (access.ts).
      // Added before every route so it covers the child contexts (supplier portal, Stage) too.
      r.addHook("preHandler", accessGuard(config));
      // Shared state (deployed builds, store/sync.ts): read what other instances changed before the handler runs, write
      // what this request changed before the response leaves. A database hiccup is logged; the request still runs.
      if (sync.enabled) {
        r.addHook("onRequest", async () => {
          await sync.pull().catch((err: unknown) => log("mock world state not read", { error: String(err) }));
        });
        r.addHook("onSend", async (_req, _reply, payload) => {
          await sync.push().catch((err: unknown) => log("mock world state not written", { error: String(err) }));
          return payload;
        });
      }

      r.get("/health", async () => ({
        ok: true,
        service: "mock-world",
        simulated: true,
        issuingProvider: issuer.provider,
        clockSource: clock instanceof DemoClock ? clock.source : "injected",
        persistence: store.persistence,
        now: (await clock.now()).toISOString(),
      }));

      // Demo reset (the API's POST /demo/reset calls this; locked on deployed builds, access.ts).
      r.post("/reset", async () => {
        await resetWorld();
        return { ok: true, simulated: true };
      });

      // Webhook delivery log: evidence for docs/evidence (spec §19 "mock-bank transfer logs"). Admin token on deployed builds.
      r.get("/outbox", async () => ({ entries: webhooks.outbox ?? [], simulated: true }));

      r.get("/", async (_req, reply) => {
        const links: [string, string][] = [
          ["Pizza Shop in Budapest", "/mock/shop/bud"],
          ["Pizza Shop in Budapest menu (JSON)", "/mock/shop/bud/menu"],
          ["Pizza Shop in Shanghai", "/mock/shop/sha"],
          ["Pizza Shop in Shanghai menu (JSON)", "/mock/shop/sha/menu"],
          ["Supplier A catalog", "/mock/suppliers/a/catalog"],
          ["Supplier B catalog", "/mock/suppliers/b/catalog"],
          ["Supplier C catalog (Shanghai)", "/mock/suppliers/c/catalog"],
          ["Supplier D catalog (Shanghai)", "/mock/suppliers/d/catalog"],
          ["Supplier A price list (PDF)", "/mock/suppliers/a/price-list.pdf"],
          ["Supplier B price list (PDF)", "/mock/suppliers/b/price-list.pdf"],
          ["Tuition invoice (PDF)", "/mock/payees/university/invoice.pdf"],
          ["Tuition invoice, swapped account (PDF)", "/mock/payees/university/invoice.pdf?variant=swapped-account"],
          ["Rent invoice (PDF)", "/mock/payees/landlord/invoice.pdf"],
          ["Insurance invoice (PDF)", "/mock/payees/insurer/invoice.pdf"],
          ["School directory (JSON)", "/mock/schools"],
          ["University in Budapest payment portal (Dana)", "/mock/schools/budapest/portal?studentId=KZ26-0417"],
          ["Inbox (JSON)", "/mock/inbox"],
          // Locked on deployed builds (access.ts): listed only where they open.
          ...(config.locked
            ? []
            : ([
                ["Mock bank transfers (JSON)", "/mock/bank/transfers"],
                ["Webhook outbox (JSON)", "/mock/outbox"],
              ] as [string, string][])),
          ...(config.demoEnabled
            ? ([
                ["Demo Stage (phone screens for the pitch)", "/mock/stage"],
                ["Pizza Shop in Budapest kitchen screen", "/mock/shop/bud/kitchen"],
                ["Pizza Shop in Budapest counter till", "/mock/shop/bud/till"],
                ["Pizza Shop in Shanghai kitchen screen", "/mock/shop/sha/kitchen"],
                ["Pizza Shop in Shanghai counter till", "/mock/shop/sha/till"],
                ["Supplier A portal (Budapest)", "/mock/supplier/a/portal"],
                ["Supplier B portal (Budapest, attacker)", "/mock/supplier/b/portal"],
                ["Supplier C portal (Shanghai)", "/mock/supplier/c/portal"],
                ["Supplier D portal (Shanghai, attacker)", "/mock/supplier/d/portal"],
              ] as [string, string][])
            : []),
        ];
        const items = links.map(([t, h]) => `<li><a href="${esc(h)}">${esc(t)}</a></li>`).join("");
        return reply
          .type("text/html; charset=utf-8")
          .send(page("Mock world", `<h1>Kassa mock world</h1><p class="muted">Simulated services for the demo. Generic names, no real brands.</p><div class="card"><ul>${items}</ul></div>`));
      });

      bankRoutes(r, bank);
      shopRoutes(r, { issuer, clock, log: charges });
      shopOrderRoutes(r, { config, book: shop });
      documentRoutes(r, { docs, publicUrl: config.publicUrl });
      qrRoutes(r, qr);
      schoolRoutes(r, { book: schools, config });
      kycRoutes(r, { desk: kyc });
      // (M5) own context: its raw-body JSON parser (HMAC check of Kassa's signed POs) stays local.
      await r.register(async (s) => supplierPortalRoutes(s, { config, book: suppliers, clock }));
      eventRoutes(r, { clock, webhooks, bank, defaultProfileId: MOCK_BANK_PROFILE_ID });

      // Demo Stage (/mock/stage/*): own encapsulation context so its DEMO_ENABLED gate covers only its routes.
      await r.register(async (s) =>
        stageRoutes(s, {
          config,
          api: new StageApi({ apiUrl: config.apiUrl, demoToken: config.demoAdminToken, ...(deps.fetch ? { fetch: deps.fetch } : {}) }),
          bank,
          qr,
          docs,
          shop: { issuer, clock, log: charges },
          clock,
          rates,
          orders: shop,
          suppliers,
          resetWorld,
          syncClock: () => {
            if (clock instanceof DemoClock) clock.invalidate();
          },
        }),
      );
    },
    { prefix: "/mock" },
  );

  if (deps.startTicker !== false) {
    const timer = setInterval(() => {
      tick().catch((err: unknown) => log("mock world tick failed", { error: String(err) }));
    }, config.bankTickMs);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }

  return { app, bank, qr, shop, suppliers, schools, kyc, webhooks, clock, persistence: store.persistence, sync, tick };
}
