/*
 * Sessions (spec §8): web = httpOnly cookie; native = bearer JWT (15 min) + refresh token.
 * JWTs per RFC 7519, HS256 with SESSION_SECRET (RFC 7518 §3.2). iat/exp come from the Clock and are
 * verified against the Clock, so advancing the demo clock behaves like real time passing.
 * Refresh tokens rotate on every use (RFC 9700 §4.14.2); a reused refresh token is rejected.
 * Honest limit: the rotation/revocation list is in memory (single process).
 */
import type {} from "@fastify/cookie"; // augments FastifyRequest.cookies / reply.setCookie
import type { FastifyReply, FastifyRequest } from "fastify";
import { decodeJwt, jwtVerify, SignJWT } from "jose";
import { randomUUID } from "node:crypto";

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
  }
}

type Typ = "access" | "refresh" | "session";

/** jti of refresh tokens already used or logged out. */
const spentRefresh = new Set<string>();

function secret(): Uint8Array {
  return new TextEncoder().encode(env().SESSION_SECRET);
}

async function mint(userId: string, typ: Typ, ttlS: number): Promise<{ token: string; exp: number }> {
  const nowS = Math.floor(clock.nowMs() / 1000);
  const exp = nowS + ttlS;
  const token = await new SignJWT({ typ })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setJti(randomUUID())
    .setIssuedAt(nowS)
    .setExpirationTime(exp)
    .sign(secret());
  return { token, exp };
}

async function verify(token: string, typ: Typ): Promise<{ sub: string; jti: string | undefined } | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      algorithms: ["HS256"],
      currentDate: clock.now(),
    });
    if (payload.typ !== typ || typeof payload.sub !== "string") return null;
    return { sub: payload.sub, jti: payload.jti };
  } catch {
    return null;
  }
}

export async function verifyToken(token: string, typ: Typ): Promise<string | null> {
  return (await verify(token, typ))?.sub ?? null;
}

export type SessionTokens = { accessToken: string; accessTokenExpiresAt: string; refreshToken: string };

async function nativeTokens(userId: string): Promise<SessionTokens> {
  const [access, refresh] = await Promise.all([mint(userId, "access", ACCESS_TTL_S), mint(userId, "refresh", REFRESH_TTL_S)]);
  return {
    accessToken: access.token,
    accessTokenExpiresAt: new Date(access.exp * 1000).toISOString(),
    refreshToken: refresh.token,
  };
}

/** web → httpOnly cookie, tokens null; native → bearer + refresh tokens in the body. */
export async function startSession(reply: FastifyReply, userId: string, client: "web" | "native"): Promise<SessionTokens | null> {
  if (client === "native") return nativeTokens(userId);
  const cookie = await mint(userId, "session", COOKIE_TTL_S);
  reply.setCookie(SESSION_COOKIE, cookie.token, {
    httpOnly: true,
    secure: env().PUBLIC_ORIGIN.startsWith("https://"),
    sameSite: "lax",
    path: "/api",
    maxAge: COOKIE_TTL_S,
  });
  return null;
}

/** Rotate: the presented refresh token is spent; a second use is rejected. */
export async function refreshSession(refreshToken: string): Promise<SessionTokens | null> {
  const v = await verify(refreshToken, "refresh");
  if (!v || !v.jti || spentRefresh.has(v.jti)) return null;
  spentRefresh.add(v.jti);
  return nativeTokens(v.sub);
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

/** Resolve the caller: `Authorization: Bearer <access JWT>` first, then the session cookie. */
export async function authenticate(req: FastifyRequest): Promise<string | null> {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return verifyToken(auth.slice(7).trim(), "access");
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (cookie) return verifyToken(cookie, "session");
  return null;
}

/** preHandler: 401 unless authenticated; sets request.userId. */
export async function requireUser(req: FastifyRequest): Promise<void> {
  const userId = await authenticate(req);
  if (!userId) throw new HttpProblem(401, "UNAUTHENTICATED", "Sign in with your passkey");
  req.userId = userId;
}

export function userIdOf(req: FastifyRequest): string {
  if (!req.userId) throw new HttpProblem(401, "UNAUTHENTICATED", "Sign in with your passkey");
  return req.userId;
}

/** Tests: an access token for a user. */
export async function mintAccessTokenForTests(userId: string): Promise<string> {
  return (await mint(userId, "access", ACCESS_TTL_S)).token;
}
