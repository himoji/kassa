/*
 * Sessions (spec §8): web = httpOnly cookie; native = bearer JWT (15 min) + refresh token.
 * JWTs per RFC 7519, HS256 with SESSION_SECRET (RFC 7518 §3.2). iat/exp come from the Clock and are
 * verified against the Clock, so advancing the demo clock behaves like real time passing.
 * Refresh tokens rotate on every use (RFC 9700 §4.14.2); a reused refresh token is rejected.
 * Honest limit: the rotation/revocation list is in memory (single process).
 */
import type {} from "@fastify/cookie"; // augments FastifyRequest.cookies / reply.setCookie
import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { decodeJwt, jwtVerify, SignJWT } from "jose";
import { randomUUID } from "node:crypto";

import { getDb } from "../../db/client.ts";
import { profiles, users } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { HttpProblem } from "../../http/problem.ts";
import { clock } from "../clock/index.ts";

export const SESSION_COOKIE = "kassa_session";
export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_S = 30 * 24 * 3600;
export const COOKIE_TTL_S = 7 * 24 * 3600;
const ISSUER = "kassa-api";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    /** Claims of the presented session (set by requireUser). */
    session?: SessionClaims;
  }
}

type Typ = "access" | "refresh" | "session";

/**
 * Extra session claims. `dev`: the dev sign-in (POST /auth/dev/login, never in production); approvals are signed by
 * the server-held dev passkey (auth/dev.ts). `scope: "lite"`: a KassaLite device paired by code; it never gets
 * passkey-gated rights (LITE_DENIED below answers 428 with a link to approve in the web app).
 */
export type SessionClaims = { dev?: true; scope?: "lite" };

function claimsOf(payload: Record<string, unknown>): SessionClaims {
  return { ...(payload.dev === true ? { dev: true as const } : {}), ...(payload.scope === "lite" ? { scope: "lite" as const } : {}) };
}

/** jti of refresh tokens already used or logged out. */
const spentRefresh = new Set<string>();

function secret(): Uint8Array {
  return new TextEncoder().encode(env().SESSION_SECRET);
}

async function mint(userId: string, typ: Typ, ttlS: number, claims: SessionClaims = {}): Promise<{ token: string; exp: number }> {
  const nowS = Math.floor(clock.nowMs() / 1000);
  const exp = nowS + ttlS;
  const token = await new SignJWT({ typ, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setJti(randomUUID())
    .setIssuedAt(nowS)
    .setExpirationTime(exp)
    .sign(secret());
  return { token, exp };
}

async function verify(token: string, typ: Typ): Promise<{ sub: string; jti: string | undefined; iat: number; claims: SessionClaims } | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      algorithms: ["HS256"],
      currentDate: clock.now(),
    });
    if (payload.typ !== typ || typeof payload.sub !== "string") return null;
    return { sub: payload.sub, jti: payload.jti, iat: payload.iat ?? 0, claims: claimsOf(payload) };
  } catch {
    return null;
  }
}

export async function verifyToken(token: string, typ: Typ): Promise<string | null> {
  return (await verify(token, typ))?.sub ?? null;
}

export type SessionTokens = { accessToken: string; accessTokenExpiresAt: string; refreshToken: string };

async function nativeTokens(userId: string, claims: SessionClaims = {}): Promise<SessionTokens> {
  const [access, refresh] = await Promise.all([mint(userId, "access", ACCESS_TTL_S, claims), mint(userId, "refresh", REFRESH_TTL_S, claims)]);
  return {
    accessToken: access.token,
    accessTokenExpiresAt: new Date(access.exp * 1000).toISOString(),
    refreshToken: refresh.token,
  };
}

/** web → httpOnly cookie, tokens null; native → bearer + refresh tokens in the body. */
export async function startSession(reply: FastifyReply, userId: string, client: "web" | "native", claims: SessionClaims = {}): Promise<SessionTokens | null> {
  if (client === "native") return nativeTokens(userId, claims);
  const cookie = await mint(userId, "session", COOKIE_TTL_S, claims);
  reply.setCookie(SESSION_COOKIE, cookie.token, {
    httpOnly: true,
    secure: env().PUBLIC_ORIGIN.startsWith("https://"),
    sameSite: "lax",
    path: "/api",
    maxAge: COOKIE_TTL_S,
  });
  return null;
}

/** The body of every sign-in response (AuthSessionResponse). */
export async function sessionBody(userId: string, tokens: SessionTokens | null) {
  const db = getDb();
  const u = (await db.select({ id: users.id, displayName: users.displayName }).from(users).where(eq(users.id, userId)))[0];
  if (!u) throw new HttpProblem(404, "NOT_FOUND", "user not found");
  const p = (await db.select({ signedAt: profiles.baseRulesSignedAt }).from(profiles).where(eq(profiles.userId, userId)))[0];
  return { user: u, onboarded: Boolean(p?.signedAt), tokens };
}

/**
 * Rotate: the presented refresh token is spent; a second use is rejected.
 * (X5, p3 B2) Refresh applies the same account checks as login: the user must exist and not be erased. Erasure
 * (GDPR Art. 17) therefore revokes every outstanding refresh token of the user at once, durably (users.erased_at,
 * not the in-memory spent list), and no new access token is ever minted for an erased account.
 */
export async function refreshSession(refreshToken: string): Promise<SessionTokens | null> {
  const v = await verify(refreshToken, "refresh");
  if (!v || !v.jti || spentRefresh.has(v.jti)) return null;
  spentRefresh.add(v.jti);
  const u = (await getDb().select({ erasedAt: users.erasedAt, sessionsRevokedAt: users.sessionsRevokedAt }).from(users).where(eq(users.id, v.sub)))[0];
  if (!u || revoked(v.iat, u.sessionsRevokedAt)) return null;
  if (u.erasedAt) throw new HttpProblem(401, "ACCOUNT_ERASED", "This account was erased", { reasonCodes: ["ACCOUNT_ERASED"] });
  // Rotation keeps the session's claims (a KassaLite session stays lite, a dev session stays dev).
  return nativeTokens(v.sub, v.claims);
}

export function revokeRefresh(refreshToken: string | undefined): void {
  if (!refreshToken) return;
  try {
    const jti = decodeJwt(refreshToken).jti;
    if (jti) spentRefresh.add(jti);
  } catch {
    // malformed: nothing to revoke
  }
}

export function endSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/api" });
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for the cookie session (OWASP CSRF Cheat Sheet, "Verifying Origin With Standard Headers"):
 * a state-changing request authenticated by the cookie must not come from a foreign Origin. Browsers send
 * Origin on every cross-origin and same-origin POST; non-browser clients use bearer tokens. SameSite=Lax
 * alone does not cover same-site origins (e.g. another port on the same host).
 */
function assertCookieOrigin(req: FastifyRequest): void {
  if (SAFE_METHODS.has(req.method)) return;
  const origin = req.headers.origin;
  if (origin === undefined) return;
  if (!env().origins.some((o) => o.replace(/\/$/, "") === origin)) {
    throw new HttpProblem(403, "CSRF_ORIGIN_MISMATCH", "Cross-origin request with a session cookie refused");
  }
}

/** A token issued before the account's sessions were revoked (sign-in with a backup code) no longer counts. */
function revoked(iat: number, revokedAt: Date | null): boolean {
  return revokedAt !== null && iat < Math.floor(revokedAt.getTime() / 1000);
}

/** Resolve the caller: `Authorization: Bearer <access JWT>` first, then the session cookie. */
export async function authenticate(req: FastifyRequest): Promise<string | null> {
  const s = await authenticateSession(req);
  if (!s) return null;
  const u = (await getDb().select({ sessionsRevokedAt: users.sessionsRevokedAt }).from(users).where(eq(users.id, s.userId)))[0];
  return u && !revoked(s.iat, u.sessionsRevokedAt) ? s.userId : null;
}

async function authenticateSession(req: FastifyRequest): Promise<{ userId: string; iat: number; claims: SessionClaims } | null> {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const v = await verify(auth.slice(7).trim(), "access");
    return v ? { userId: v.sub, iat: v.iat, claims: v.claims } : null;
  }
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (cookie) {
    const v = await verify(cookie, "session");
    if (v) assertCookieOrigin(req);
    return v ? { userId: v.sub, iat: v.iat, claims: v.claims } : null;
  }
  return null;
}

/**
 * Routes a KassaLite session may not use: everything that needs the user's passkey (approvals, signing, loosening,
 * erasure) or mints new credentials. They answer 428 PASSKEY_REQUIRED with `approveInWebApp` so the app opens the web
 * app instead; the passkey itself still guards each of them for full sessions.
 */
export const LITE_DENIED: ReadonlySet<string> = new Set([
  "POST /api/orders/:proposalId/approve",
  "POST /api/payees/:id/verify-callback",
  "POST /api/funding-sources/:id/confirm",
  "POST /api/onboarding/confirm",
  "POST /api/onboarding/confirm/options",
  "POST /api/mandates",
  "POST /api/mandates/options",
  "POST /api/mandates/:id/revoke",
  "PATCH /api/settings",
  "PUT /api/budgets",
  "POST /api/unfreeze",
  "POST /api/privacy/erase",
  "POST /api/auth/pair/start",
  "POST /api/devices/shortcut",
  "POST /api/auth/register/options",
  "POST /api/auth/recovery-codes",
  "POST /api/business/purchase-orders/:id/sign",
  "POST /api/business/purchase-orders/:id/sign/options",
]);

/**
 * Where the web app shows what a refused lite request was about (the order to approve, the recipient to verify), with
 * `from=lite` so the web app can send the person back to KassaLite afterwards. Other routes open the web app's start.
 */
export function approveInWebAppUrl(route: string, params: unknown): string {
  const origin = env().PUBLIC_ORIGIN.replace(/\/$/, "");
  const p = (params ?? {}) as Record<string, unknown>;
  const id = (k: string) => (typeof p[k] === "string" && /^[0-9a-f-]{36}$/i.test(p[k] as string) ? (p[k] as string) : null);
  // Each passkey step opens the web page where it is done (the start page only for routes without one).
  const pages: Record<string, string> = {
    "POST /api/funding-sources/:id/confirm": "/linked-accounts",
    "PATCH /api/settings": "/settings",
    "PUT /api/budgets": "/settings",
    "POST /api/unfreeze": "/settings",
    "POST /api/mandates": "/payees",
    "POST /api/mandates/options": "/payees",
    "POST /api/mandates/:id/revoke": "/payees",
    "POST /api/privacy/erase": "/data",
    "POST /api/auth/recovery-codes": "/backup-codes",
    "POST /api/devices/shortcut": "/shortcut",
    "POST /api/auth/pair/start": "/pair-lite",
    "POST /api/business/purchase-orders/:id/sign": "/orders",
    "POST /api/business/purchase-orders/:id/sign/options": "/orders",
    "POST /api/onboarding/confirm": "/onboarding/review",
    "POST /api/onboarding/confirm/options": "/onboarding/review",
  };
  const path =
    route === "POST /api/orders/:proposalId/approve" && id("proposalId")
      ? `/order/${id("proposalId")}`
      : route === "POST /api/payees/:id/verify-callback" && id("id")
        ? `/payees/${id("id")}`
        : (pages[route] ?? "/");
  return `${origin}${path}?from=lite`;
}

/**
 * Session check (zero trust: every request, no network trust). Installed on every non-public route by
 * http/security.ts (deny by default); idempotent, so per-plugin hooks may still call it. Tokens of a user
 * that no longer exists or was erased (GDPR Art. 17) are refused even before they expire.
 */
export async function requireUser(req: FastifyRequest): Promise<void> {
  if (req.userId) return;
  const s = await authenticateSession(req);
  if (!s) throw new HttpProblem(401, "UNAUTHENTICATED", "Sign in with your passkey");
  const { userId } = s;
  const u = (await getDb().select({ erasedAt: users.erasedAt, sessionsRevokedAt: users.sessionsRevokedAt }).from(users).where(eq(users.id, userId)))[0];
  if (!u || revoked(s.iat, u.sessionsRevokedAt)) throw new HttpProblem(401, "UNAUTHENTICATED", "Sign in with your passkey");
  if (u.erasedAt) throw new HttpProblem(401, "ACCOUNT_ERASED", "This account was erased", { reasonCodes: ["ACCOUNT_ERASED"] });
  const route = `${req.method} ${req.routeOptions.url ?? ""}`;
  if (s.claims.scope === "lite" && LITE_DENIED.has(route)) {
    throw new HttpProblem(428, "PASSKEY_REQUIRED", "Approve this in the Kassa web app with your passkey", {
      reasonCodes: ["PASSKEY_REQUIRED"],
      details: { approveInWebApp: approveInWebAppUrl(route, req.params) },
    });
  }
  req.userId = userId;
  req.session = s.claims;
}

export function userIdOf(req: FastifyRequest): string {
  if (!req.userId) throw new HttpProblem(401, "UNAUTHENTICATED", "Sign in with your passkey");
  return req.userId;
}

/** Tests: an access token for a user. */
export async function mintAccessTokenForTests(userId: string, claims: SessionClaims = {}): Promise<string> {
  return (await mint(userId, "access", ACCESS_TTL_S, claims)).token;
}

/** Tests: a web session cookie value for a user. */
export async function mintSessionCookieForTests(userId: string): Promise<string> {
  return (await mint(userId, "session", COOKIE_TTL_S)).token;
}
