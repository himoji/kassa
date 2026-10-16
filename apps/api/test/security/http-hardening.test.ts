/*
 * Zero trust at the HTTP edge (OWASP API Top 10 2023: API2 broken authentication, API4 resource consumption,
 * API8 misconfiguration): deny-by-default route registration, security headers, strict CORS, cookie CSRF
 * origin check, rate limits, body limits, problem+json without internals, demo admin hardening.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { rateLimitCounters } from "../../src/db/schema.ts";
import { resetEnvCache, setEnvForTests, env } from "../../src/env.ts";
import { PUBLIC_ROUTES, registeredRoutes } from "../../src/http/security.ts";
import { mintAccessTokenForTests, mintSessionCookieForTests, SESSION_COOKIE } from "../../src/modules/auth/session.ts";
import { demoTokenMatches } from "../../src/modules/demo/routes.ts";
import { buildServer } from "../../src/server.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey } from "../helpers/fixtures.ts";

useTestDb();

/** Concrete URL for a route pattern (valid shapes, so schemas never answer before auth would). */
function concrete(url: string): string {
  return url
    .replace(":file", "AAAAAAAAAAAAAAAAAAAAAA.json")
    .replace(":scenario", "settlement")
    .replace(/\/public\/verify\/:id/, "/public/verify/AAAAAAAAAAAAAAAAAAAAAA")
    .replace(/:[A-Za-z]+/g, "00000000-0000-4000-8000-000000000000");
}

/** Public routes that authenticate by other means: an unauthenticated call must never succeed. */
const ALT_AUTH = Object.entries(PUBLIC_ROUTES)
  .filter(([, why]) => /HMAC|Stripe-Signature|device bearer|demo admin token|authenticated by/.test(why))
  .map(([k]) => k);

describe("deny-by-default route registration", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    setEnvForTests({ DEMO_ADMIN_TOKEN: "t".repeat(40) });
    app = await buildServer({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    resetEnvCache();
  });

  it("every registered /api route is either allow-listed or answers 401 without credentials", async () => {
    const routes = registeredRoutes(app).filter((r) => r.url.startsWith("/api") && r.method !== "HEAD" && r.method !== "OPTIONS");
    expect(routes.length).toBeGreaterThan(50);
    const unexpectedPublic: string[] = [];
    const notRejected: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.url}`;
      if (r.public) {
        if (!(key in PUBLIC_ROUTES)) unexpectedPublic.push(key);
        continue;
      }
      const res = await app.inject({ method: r.method as "GET", url: concrete(r.url), payload: r.method === "GET" ? undefined : {} });
      if (res.statusCode !== 401) notRejected.push(`${key} → ${res.statusCode}`);
      else expect(res.headers["content-type"]).toContain("application/problem+json");
    }
    expect(unexpectedPublic).toEqual([]);
    expect(notRejected).toEqual([]);
  });

  it("the allow-list has no stale entries and documents why each route is public", () => {
    const keys = new Set(registeredRoutes(app).map((r) => `${r.method} ${r.url}`));
    for (const [k, why] of Object.entries(PUBLIC_ROUTES)) {
      expect(keys.has(k), `${k} is allow-listed but not registered`).toBe(true);
      expect(why.length).toBeGreaterThan(10);
    }
  });

  it("every input is schema-validated: bodies (zod) and path params, with documented exceptions", () => {
    // Bodies parsed by other means: HMAC/Stripe-verified webhook bodies (read defensively field by field
    // after the signature check) and the multipart uploads (type/size checked in the handler; import files are sniffed by their bytes).
    const RAW_BODY_OK = new Set([
      "POST /api/webhooks/mock/bank",
      "POST /api/webhooks/mock/qr",
      "POST /api/webhooks/mock/pos",
      "POST /api/webhooks/mock/remittance",
      "POST /api/webhooks/mock/shop",
      "POST /api/webhooks/mock/supplier",
      "POST /api/webhooks/mock/school",
      "POST /api/rails/fake-issuing/authorize",
      "POST /api/webhooks/stripe",
      "POST /api/agent/documents",
      "POST /api/import/file",
    ]);
    // Action endpoints that take no body (path params or session only).
    const NO_BODY = /\/(freeze|read|revoke|verify-callback|intent|simulate-success|restrict|reset|login\/options|devices\/shortcut|school-invoices)$|\/demo\/trigger\/:scenario$/;
    const routes = registeredRoutes(app).filter((r) => r.url.startsWith("/api") && ["POST", "PATCH", "PUT"].includes(r.method));
    const unvalidated = routes.filter((r) => !r.bodySchema && !RAW_BODY_OK.has(`${r.method} ${r.url}`) && !NO_BODY.test(r.url)).map((r) => `${r.method} ${r.url}`);
    expect(unvalidated).toEqual([]);
    const paramsUnvalidated = registeredRoutes(app).filter((r) => r.url.startsWith("/api") && r.url.includes(":") && !r.paramsSchema).map((r) => `${r.method} ${r.url}`);
    expect(paramsUnvalidated).toEqual([]);
  });

  it("public routes with their own authentication refuse unauthenticated calls", async () => {
    expect(ALT_AUTH.length).toBeGreaterThanOrEqual(10);
    for (const key of ALT_AUTH) {
      const [method, url] = key.split(" ") as [string, string];
      const res = await app.inject({ method: method as "POST", url: concrete(url), payload: key.includes("refresh") ? { refreshToken: "x.y.z" } : {} });
      expect(res.statusCode, key).toBeGreaterThanOrEqual(400);
      expect([401, 403, 503], key).toContain(res.statusCode);
    }
  });

  it("a valid bearer token passes the gate; a token of an unknown user does not", async () => {
    const { userId } = await createUserWithPasskey();
    const ok = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${await mintAccessTokenForTests(userId)}` } });
    expect(ok.statusCode).toBe(200);
    const ghost = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${await mintAccessTokenForTests("00000000-0000-4000-8000-00000000dead")}` } });
    expect(ghost.statusCode).toBe(401);
  });
});

describe("headers, CORS, CSRF, body limits, error bodies", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildServer({ logger: false });
    app.get("/api/__boom", async () => {
      throw new Error("db password=hunter2 at /srv/secret.ts:42");
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it("sets security headers (helmet)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(res.headers["content-security-policy"])).toContain("default-src 'none'");
    expect(String(res.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("CORS: only configured origins, with credentials", async () => {
    const good = await app.inject({ method: "OPTIONS", url: "/api/me", headers: { origin: env().PUBLIC_ORIGIN, "access-control-request-method": "GET" } });
    expect(good.headers["access-control-allow-origin"]).toBe(env().PUBLIC_ORIGIN);
    expect(good.headers["access-control-allow-credentials"]).toBe("true");
    const bad = await app.inject({ method: "OPTIONS", url: "/api/me", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    const simple = await app.inject({ method: "GET", url: "/api/health", headers: { origin: "https://evil.example" } });
    expect(simple.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("CORS preflight allows exactly the headers the web client sends (apps/mobile/src/api/client.ts)", async () => {
    const list = (v: unknown) => String(v).toLowerCase().split(",").map((s) => s.trim());
    // The web client sends `accept` (CORS-safelisted, Fetch §2.2.2), `content-type: application/json` (not
    // safelisted → preflight) and, on the demo panel, the demo admin token. Session = cookie, so no authorization.
    const cases = [
      { url: "/api/auth/register/options", method: "POST", headers: "content-type" },
      { url: "/api/agent/message", method: "POST", headers: "content-type" },
      { url: "/api/settings", method: "PATCH", headers: "content-type" },
      { url: "/api/demo/reset", method: "POST", headers: "content-type,x-kassa-demo-token" },
    ];
    for (const c of cases) {
      const res = await app.inject({
        method: "OPTIONS",
        url: c.url,
        headers: { origin: env().PUBLIC_ORIGIN, "access-control-request-method": c.method, "access-control-request-headers": c.headers },
      });
      expect(res.statusCode, c.url).toBe(204);
      expect(res.headers["access-control-allow-origin"], c.url).toBe(env().PUBLIC_ORIGIN);
      expect(res.headers["access-control-allow-credentials"], c.url).toBe("true");
      expect(list(res.headers["access-control-allow-methods"]), c.url).toContain(c.method.toLowerCase());
      const allowed = list(res.headers["access-control-allow-headers"]);
      for (const h of c.headers.split(",")) expect(allowed, `${c.url} ${h}`).toContain(h);
    }
    // No client-marker header: the API never reads one, so it stays off the allow-list (deny by default).
    const marker = await app.inject({
      method: "OPTIONS",
      url: "/api/me",
      headers: { origin: env().PUBLIC_ORIGIN, "access-control-request-method": "GET", "access-control-request-headers": "x-kassa-client" },
    });
    expect(list(marker.headers["access-control-allow-headers"])).not.toContain("x-kassa-client");
  });

  it("cookie sessions refuse state-changing requests from a foreign Origin (CSRF)", async () => {
    const { userId } = await createUserWithPasskey();
    const cookie = `${SESSION_COOKIE}=${await mintSessionCookieForTests(userId)}`;
    const foreign = await app.inject({ method: "POST", url: "/api/freeze", headers: { cookie, origin: "http://localhost:4001" } });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ code: "CSRF_ORIGIN_MISMATCH" });
    const same = await app.inject({ method: "POST", url: "/api/freeze", headers: { cookie, origin: env().PUBLIC_ORIGIN } });
    expect(same.statusCode).toBe(200);
    // Reads are not state-changing: allowed (CORS keeps the response from foreign scripts).
    const read = await app.inject({ method: "GET", url: "/api/me", headers: { cookie, origin: "http://localhost:4001" } });
    expect(read.statusCode).toBe(200);
  });

  it("rejects JSON bodies over 1 MiB with 413 problem+json", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login/options", headers: { "content-type": "application/json" }, payload: JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }) });
    expect(res.statusCode).toBe(413);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });

  it("5xx problem+json carries no message, stack or path", async () => {
    const { userId } = await createUserWithPasskey();
    const res = await app.inject({ method: "GET", url: "/api/__boom", headers: { authorization: `Bearer ${await mintAccessTokenForTests(userId)}` } });
    expect(res.statusCode).toBe(500);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.body).not.toMatch(/hunter2|secret\.ts|at \/|stack/i);
    expect(res.json()).toMatchObject({ status: 500, code: "INTERNAL", title: "Internal Server Error" });
  });
});

describe("rate limits", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    setEnvForTests({ RATE_LIMIT_AUTH_PER_MIN: "3", RATE_LIMIT_SENSITIVE_PER_MIN: "2", RATE_LIMIT_GLOBAL_PER_MIN: "50" });
    // Counters are in Postgres and shared by every server on the database (R13): start from none.
    await getDb().delete(rateLimitCounters);
    app = await buildServer({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    resetEnvCache();
  });

  it("auth endpoints: the 4th call in a minute gets 429 RATE_LIMITED", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: "POST", url: "/api/auth/login/options" })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    const res = await app.inject({ method: "POST", url: "/api/auth/login/options" });
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json()).toMatchObject({ status: 429, code: "RATE_LIMITED", reasonCodes: ["RATE_LIMITED"] });
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("buckets are per route: public verify has its own budget", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: "GET", url: "/api/public/verify/AAAAAAAAAAAAAAAAAAAAAA" })).statusCode);
    expect(codes).toEqual([404, 404, 404, 429]);
  });

  it("order approval and Shortcut capture use the sensitive budget", async () => {
    const { userId } = await createUserWithPasskey();
    const h = { authorization: `Bearer ${await mintAccessTokenForTests(userId)}` };
    const url = "/api/orders/00000000-0000-4000-8000-000000000000/approve";
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await app.inject({ method: "POST", url, headers: h, payload: { assertion: { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "", authenticatorData: "", signature: "" }, clientExtensionResults: {} } } })).statusCode);
    expect(codes.slice(0, 2).every((c) => c !== 429)).toBe(true);
    expect(codes[2]).toBe(429);
    const sc: number[] = [];
    for (let i = 0; i < 3; i++) sc.push((await app.inject({ method: "POST", url: "/api/capture/shortcut", payload: {} })).statusCode);
    expect(sc).toEqual([401, 401, 429]);
  });

  it("the global budget applies to every other route", async () => {
    let last = 0;
    for (let i = 0; i < 51; i++) last = (await app.inject({ method: "GET", url: "/api/health" })).statusCode;
    expect(last).toBe(429);
  });
});

describe("demo admin hardening", () => {
  afterEach(() => resetEnvCache());

  it("compares the admin token in constant time over digests (any length)", () => {
    expect(demoTokenMatches("a".repeat(40), "a".repeat(40))).toBe(true);
    expect(demoTokenMatches("a".repeat(39), "a".repeat(40))).toBe(false);
    expect(demoTokenMatches(undefined, "a".repeat(40))).toBe(false);
    expect(demoTokenMatches(["a"], "a")).toBe(false);
  });

  it("admin routes need the token when one is configured", async () => {
    setEnvForTests({ DEMO_ADMIN_TOKEN: "s".repeat(40) });
    const app = await buildServer({ logger: false });
    try {
      const none = await app.inject({ method: "POST", url: "/api/demo/agent-mode", payload: { mode: "REPLAY" } });
      expect(none.statusCode).toBe(403);
      const wrong = await app.inject({ method: "POST", url: "/api/demo/agent-mode", headers: { "x-kassa-demo-token": "s".repeat(39) }, payload: { mode: "REPLAY" } });
      expect(wrong.statusCode).toBe(403);
      const right = await app.inject({ method: "POST", url: "/api/demo/agent-mode", headers: { "x-kassa-demo-token": "s".repeat(40) }, payload: { mode: "REPLAY" } });
      expect(right.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("DEMO_ENABLED=false: demo routes do not exist", async () => {
    setEnvForTests({ DEMO_ENABLED: "false" });
    const app = await buildServer({ logger: false });
    try {
      expect((await app.inject({ method: "GET", url: "/api/demo/clock" })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: "/api/demo/reset" })).statusCode).toBe(404);
      expect(registeredRoutes(app).some((r) => r.url.startsWith("/api/demo"))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("production refuses to start with demo enabled and a weak admin token", () => {
    const keys = {
      RULES_SIGNING_KEY: env().RULES_SIGNING_KEY,
      RULES_PUBLIC_KEY: "MCowBQYDK2VwAyEA" + "A".repeat(43) + "=",
      LEDGER_CHECKPOINT_KEY: env().LEDGER_CHECKPOINT_KEY,
      ACCOUNT_ENC_KEY: env().ACCOUNT_ENC_KEY,
      USER_KEK: env().USER_KEK,
      SESSION_SECRET: env().SESSION_SECRET,
      MOCK_HMAC_SECRET: "m".repeat(32),
    };
    setEnvForTests({ ...keys, NODE_ENV: "production", DEMO_ENABLED: "true", DEMO_ADMIN_TOKEN: "short" });
    expect(() => env()).toThrow(/DEMO_ADMIN_TOKEN/);
    setEnvForTests({ ...keys, NODE_ENV: "production", DEMO_ENABLED: "true", DEMO_ADMIN_TOKEN: "x".repeat(32) });
    expect(env().DEMO_ENABLED).toBe(true);
    setEnvForTests({ ...keys, NODE_ENV: "production", DEMO_ENABLED: "false", DEMO_ADMIN_TOKEN: "" });
    expect(env().DEMO_ENABLED).toBe(false);
  });
});
