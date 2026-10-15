/*
 * HTTP security layer (zero trust; OWASP API Security Top 10 2023, OWASP ASVS 4.0.3 V4/V13/V14).
 *
 * - Deny by default (API2 / ASVS 4.1.5): every route gets the session check (`requireUser`, onRequest — before
 *   body parsing) unless it is listed in PUBLIC_ROUTES with the reason it may skip it. Listed routes either
 *   carry no personal data or use their own authentication (webhook HMAC / Stripe signature, device token,
 *   demo admin token, refresh token). A test enumerates every registered route against this list.
 * - Rate limits (API4): @fastify/rate-limit, global per-IP budget plus tighter buckets for authentication,
 *   public verification, order approval, Shortcut capture, privacy actions and demo admin calls.
 * - Body size (API4): 1 MiB JSON by default; the document upload route allows 11 MiB (multipart enforces 10 MB).
 * - Security headers (ASVS V14.4): @fastify/helmet with an API CSP (`default-src 'none'`), no framing.
 * - CORS (ASVS V14.5.3): only the configured origins (PUBLIC_ORIGIN + EXTRA_ORIGINS), credentials allowed;
 *   requests without an Origin (native app, webhooks, curl) are not CORS requests and are unaffected.
 * Honest limit: rate-limit counters are in memory (per API instance; the challenge stores and pairing codes are in
 * Postgres, auth/challenges.ts).
 */
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, RouteOptions } from "fastify";

import { env } from "../env.ts";
import { requireUser } from "../modules/auth/session.ts";
import { HttpProblem } from "./problem.ts";

/** "METHOD /api/path" → why the route may skip the session check (and what authenticates it instead). */
export const PUBLIC_ROUTES: Readonly<Record<string, string>> = {
  "GET /api/health": "liveness probe, no data",
  "POST /api/auth/register/options": "starts passkey registration; an existing session is read optionally (adding a device)",
  "POST /api/auth/register/verify": "WebAuthn attestation over a single-use server challenge",
  "POST /api/auth/login/options": "starts passkey sign-in",
  "POST /api/auth/login/verify": "WebAuthn assertion over a single-use server challenge",
  "POST /api/auth/recovery/options": "lost passkey: a single-use backup code (auth/recovery.ts) instead of a session",
  "POST /api/auth/recovery/verify": "lost passkey: new-passkey registration bound to the backup code's single-use challenge",
  "POST /api/auth/refresh": "authenticated by the rotating refresh token in the body (RFC 9700)",
  "POST /api/auth/logout": "only clears the cookie / revokes the presented refresh token",
  "GET /api/auth/demo": "whether the welcome screen offers the demo account / dev sign-in (flags only, no personal data)",
  "POST /api/auth/dev/login": "dev sign-in: not registered in production; DEMO_ENABLED + DEV_LOGIN + a localhost / tunnel RP_ID (auth/dev.ts)",
  "POST /api/auth/pair/complete": "single-use 8-character pairing code, 2-minute TTL, created behind a passkey assertion (auth/pair.ts)",
  "GET /api/public/verify/:id": "lender verification of a credit record by its 128-bit capability id",
  "GET /api/public/credit-record/:file": "credit record JSON/PDF by its 128-bit capability id",
  "GET /api/fx/rates": "published reference FX rates, no personal data (mock-world reads them)",
  "GET /api/privacy/ai-notice": "AI transparency notice shown before sign-up (EU AI Act Art. 50), no personal data",
  "POST /api/webhooks/mock/bank": "HMAC-SHA256 over timestamp.body, 5-min window (I13)",
  "POST /api/webhooks/mock/qr": "HMAC-SHA256 over timestamp.body, 5-min window (I13)",
  "POST /api/webhooks/mock/pos": "HMAC-SHA256 over timestamp.body, 5-min window (I13)",
  "POST /api/webhooks/mock/remittance": "HMAC-SHA256 over timestamp.body, 5-min window (I13)",
  "POST /api/webhooks/mock/shop": "HMAC-SHA256 over timestamp.body, 5-min window (I13)",
  "POST /api/webhooks/mock/supplier": "HMAC-SHA256 over timestamp.body, 5-min window (I13); invoices three-way matched (M5)",
  "POST /api/webhooks/mock/school": "HMAC-SHA256 over timestamp.body, 5-min window (I13); matched to a payment Kassa sent",
  "POST /api/rails/fake-issuing/authorize": "HMAC-SHA256 over timestamp.body, 5-min window (I13)",
  "POST /api/webhooks/stripe": "Stripe-Signature over the raw body (I13)",
  "POST /api/capture/shortcut": "per-device bearer token, only its hash is stored (I13)",
  "GET /api/demo/clock": "demo clock read for mock-world (DEMO_ENABLED only, no personal data)",
  "POST /api/demo/clock/advance": "demo admin token, constant-time compare (DEMO_ENABLED only)",
  "POST /api/demo/reset": "demo admin token, constant-time compare (DEMO_ENABLED only)",
  "POST /api/demo/agent-mode": "demo admin token, constant-time compare (DEMO_ENABLED only)",
  "POST /api/demo/trigger/:scenario": "demo admin token, constant-time compare (DEMO_ENABLED only)",
  "POST /api/demo/stage/shortcut-token": "demo admin token, constant-time compare (DEMO_ENABLED only)",
  "POST /api/demo/stage/settlement": "demo admin token, constant-time compare (DEMO_ENABLED only)",
  "POST /api/demo/stage/document": "demo admin token, constant-time compare (DEMO_ENABLED only)",
};

type Tier = "auth" | "sensitive";
/** Routes with a tighter per-IP bucket than the global one. */
export const RATE_LIMITED_ROUTES: Readonly<Record<string, Tier>> = {
  "POST /api/auth/register/options": "auth",
  "POST /api/auth/register/verify": "auth",
  "POST /api/auth/login/options": "auth",
  "POST /api/auth/login/verify": "auth",
  "POST /api/auth/recovery/options": "auth",
  "POST /api/auth/recovery/verify": "auth",
  "POST /api/auth/recovery-codes": "sensitive",
  "POST /api/auth/refresh": "auth",
  "POST /api/auth/dev/login": "auth",
  "POST /api/auth/pair/start": "auth",
  "POST /api/auth/pair/complete": "auth",
  "GET /api/public/verify/:id": "auth",
  "GET /api/public/credit-record/:file": "auth",
  "POST /api/demo/clock/advance": "auth",
  "POST /api/demo/reset": "auth",
  "POST /api/demo/agent-mode": "auth",
  "POST /api/demo/trigger/:scenario": "auth",
  "POST /api/demo/stage/shortcut-token": "auth",
  "POST /api/demo/stage/settlement": "auth",
  "POST /api/demo/stage/document": "auth",
  "POST /api/orders/:proposalId/approve": "sensitive",
  "POST /api/merchant-bills/:billId/propose": "sensitive",
  "POST /api/capture/shortcut": "sensitive",
  "POST /api/unfreeze": "sensitive",
  "POST /api/privacy/erase": "sensitive",
  "GET /api/privacy/export": "sensitive",
  "GET /api/export": "sensitive",
  "POST /api/import/preview": "sensitive",
  "POST /api/import/commit": "sensitive",
  "POST /api/privacy/restrict": "sensitive",
};

export const DEFAULT_BODY_LIMIT = 1024 * 1024;
const BODY_LIMITS: Readonly<Record<string, number>> = {
  "POST /api/agent/documents": 11 * 1024 * 1024,
  // A data import's JSON (dataport); Vercel caps request bodies at 4.5 MB anyway.
  "POST /api/import/preview": 5 * 1024 * 1024,
  "POST /api/import/commit": 5 * 1024 * 1024,
};

/** Route keys for one route definition (method may be an array; HEAD follows its GET). */
export function routeKeys(route: Pick<RouteOptions, "method" | "url">): string[] {
  const methods = Array.isArray(route.method) ? route.method : [route.method];
  return methods.map((m) => `${m === "HEAD" ? "GET" : String(m).toUpperCase()} ${route.url}`);
}

const isPreflight = (route: Pick<RouteOptions, "method">) =>
  (Array.isArray(route.method) ? route.method : [route.method]).every((m) => m === "OPTIONS");

export function isPublicRoute(route: Pick<RouteOptions, "method" | "url">): boolean {
  // CORS preflights carry no credentials by definition (Fetch standard §4.8); @fastify/cors answers them.
  if (isPreflight(route)) return true;
  return routeKeys(route).every((k) => k in PUBLIC_ROUTES);
}

/** Every route registered on an app (method + url), for the deny-by-default audit test. */
export type RegisteredRoute = { method: string; url: string; public: boolean; bodySchema: boolean; paramsSchema: boolean };
const ROUTES = new WeakMap<FastifyInstance, RegisteredRoute[]>();
export function registeredRoutes(app: FastifyInstance): readonly RegisteredRoute[] {
  return ROUTES.get(app) ?? [];
}

const hooksOf = (h: RouteOptions["onRequest"]) => (h === undefined ? [] : Array.isArray(h) ? h : [h]);

/**
 * Call BEFORE registering any route. Order matters: (1) config hook (limits) → (2) rate-limit plugin, whose
 * own onRoute hook reads `config.rateLimit` → (3) auth hook, appended after the rate-limit hook so floods of
 * unauthenticated requests are counted too.
 */
export async function registerSecurity(app: FastifyInstance): Promise<void> {
  const e = env();

  await app.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
    crossOriginResourcePolicy: { policy: "same-site" },
    referrerPolicy: { policy: "no-referrer" },
    strictTransportSecurity: e.PUBLIC_ORIGIN.startsWith("https://") ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  const allowed = new Set(e.origins.map((o) => o.replace(/\/$/, "")));
  await app.register(cors, {
    origin: (origin, cb) => cb(null, origin === undefined || allowed.has(origin)),
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    // Exactly what the clients send (apps/mobile/src/api/client.ts; preflight test in http-hardening.test.ts).
    allowedHeaders: ["content-type", "authorization", "x-kassa-demo-token"],
    maxAge: 600,
  });

  const perMin = { auth: e.RATE_LIMIT_AUTH_PER_MIN, sensitive: e.RATE_LIMIT_SENSITIVE_PER_MIN } as const;
  // Route-level onRequest hooks (e.g. device-token or demo-token checks) are parked here and re-added after
  // the rate-limit hook, so failed authentication attempts are counted too.
  const parked = new WeakMap<object, RouteOptions["onRequest"]>();
  app.addHook("onRoute", (route) => {
    if (route.onRequest !== undefined) {
      parked.set(route, route.onRequest);
      route.onRequest = [];
    }
    for (const key of routeKeys(route)) {
      const tier = RATE_LIMITED_ROUTES[key];
      if (tier) route.config = { ...route.config, rateLimit: { max: perMin[tier], timeWindow: 60_000 } };
      const limit = BODY_LIMITS[key];
      if (limit && route.bodyLimit === undefined) route.bodyLimit = limit;
    }
  });

  await app.register(rateLimit, {
    global: true,
    max: e.RATE_LIMIT_GLOBAL_PER_MIN,
    timeWindow: 60_000,
    errorResponseBuilder: (_req, ctx) =>
      new HttpProblem(429, "RATE_LIMITED", `Too many requests; retry in ${ctx.after}`, { reasonCodes: ["RATE_LIMITED"] }),
  });

  const seen: RegisteredRoute[] = [];
  ROUTES.set(app, seen);
  app.addHook("onRoute", (route) => {
    const pub = isPublicRoute(route);
    const schema = route.schema as { body?: unknown; params?: unknown } | undefined;
    for (const m of Array.isArray(route.method) ? route.method : [route.method]) {
      seen.push({ method: String(m), url: route.url, public: pub, bodySchema: schema?.body !== undefined, paramsSchema: schema?.params !== undefined });
    }
    // Order: rate limit → route's own authentication → session check (deny by default).
    route.onRequest = [...hooksOf(route.onRequest), ...hooksOf(parked.get(route)), ...(pub ? [] : [requireUser])];
  });
}
