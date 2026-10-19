import { AuthSessionResponse, ClientKind, type MandateCore } from "@kassa/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { users, webauthnCredentialsPayments, webauthnCredentialsRules } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { audit } from "../../http/audit.ts";
import { HttpProblem } from "../../http/problem.ts";
import { clock } from "../clock/index.ts";
import { createUser } from "../users/service.ts";
import { activateJudgeCopyMandates } from "../mandates/service.ts";
import { demoClaimUserId, judgeDemoCopy } from "./demoClaim.ts";
import { mintInternalAccessToken, requireUser, sessionBody, startSession, userIdOf } from "./session.ts";
import { SoftAuthenticator } from "./soft-authenticator.ts";

/*
 * Dev sign-in (local development and phone testing through a tunnel, where a passkey is a dead end: a quick tunnel's
 * host changes every run, so passkeys bound to it never work twice).
 *
 * POST /auth/dev/login creates (or reuses) a "Dev" user with a server-held software passkey and starts a session
 * carrying `dev: true`. The app's two modes pick the account: dev mode (`fresh`) makes a brand-new user every time,
 * so onboarding starts from scratch; demo mode (`demoClaim`, as in the demo-claim registration) enters a seeded demo
 * persona without a platform passkey. Approvals still go through the normal WebAuthn checks: POST /auth/dev/assert signs the 428
 * challenge with a server-held key, for dev sessions only (session claim `dev: true`, set by POST /auth/dev/login and
 * kept on refresh). A session that signed in with a real passkey is refused (403 NOT_DEV_SESSION): otherwise a stolen
 * access token alone could approve payments on that account wherever dev sign-in is on (security review 2026-10-18;
 * the app's "Dev" button therefore shows in dev sessions only). KassaLite sessions never get it (they never get
 * passkey-gated rights). Nothing else in the passkey verification changes.
 *
 * Guards, all required: the routes are not registered when NODE_ENV=production; each request also needs
 * DEMO_ENABLED and DEV_LOGIN, and RP_ID must be localhost, a *.trycloudflare.com quick tunnel or PHONE_HOST.
 * The one exception is the judge build (`judgeModeActive`): JUDGE_MODE + DEMO_ENABLED on a separate deployment.
 *
 * Judge build: reviewers must not see each other's actions, so no sign-in reuses an account. `demoClaim` makes a
 * private copy of that seeded persona under a new user id (auth/demoClaim.ts `judgeDemoCopy`) and signs its onboarding
 * with the copy's dev passkey through the app's own routes (base rules, then the persona's seeded mandates), so the
 * app opens on the home screen and every signature verifies like a user's. `fresh` and the plain sign-in both make a
 * brand-new user (onboarding from the start); the shared "Dev" user is never used there.
 */

export const DEV_DISPLAY_NAME = "Dev";
/** Dev mode users: a new one per sign-in, never reused (the reused "Dev" user is looked up by its name). */
export const DEV_FRESH_DISPLAY_NAME = "Dev (fresh)";

/** One software passkey per dev user, for this process (a restart registers a fresh one on the next use). */
const devKeys = new Map<string, SoftAuthenticator>();

/**
 * Judge build: JUDGE_MODE + DEMO_ENABLED, set only on a separate deployment with its own demo-only database (README,
 * "Deploy on Vercel"). The public demo never sets JUDGE_MODE, so its approvals always need a real passkey.
 */
export function judgeModeActive(): boolean {
  const e = env();
  return e.JUDGE_MODE && e.DEMO_ENABLED;
}

export function devLoginAllowed(): boolean {
  const e = env();
  if (judgeModeActive()) return true;
  if (e.NODE_ENV === "production" || !e.DEMO_ENABLED || !e.DEV_LOGIN) return false;
  const rp = e.RP_ID.toLowerCase();
  return rp === "localhost" || rp === "127.0.0.1" || rp.endsWith(".trycloudflare.com") || (!!e.PHONE_HOST && rp === e.PHONE_HOST.toLowerCase());
}

function assertAllowed(): void {
  if (!devLoginAllowed()) throw new HttpProblem(404, "NOT_FOUND", "Route not found");
}

async function devKeyFor(userId: string): Promise<SoftAuthenticator> {
  const existing = devKeys.get(userId);
  if (existing) return existing;
  const key = new SoftAuthenticator();
  const row = { userId, credentialId: key.id, publicKey: key.publicKeyB64u(), counter: 0, transports: ["internal"] };
  await getDb().transaction(async (tx) => {
    await tx.insert(webauthnCredentialsRules).values(row);
    await tx.insert(webauthnCredentialsPayments).values(row);
  });
  devKeys.set(userId, key);
  return key;
}

async function newDevUser(displayName: string): Promise<string> {
  const id = randomUUID();
  await getDb().transaction(async (tx) => {
    await createUser(tx, { id, displayName });
    // Dev convenience: consent to AI processing so the chat works right away (shown in Settings → Privacy).
    await tx.update(users).set({ aiConsentAt: clock.now() }).where(eq(users.id, id));
  });
  return id;
}

async function devUser(): Promise<string> {
  const db = getDb();
  const found = (await db.select({ id: users.id, erasedAt: users.erasedAt }).from(users).where(eq(users.displayName, DEV_DISPLAY_NAME)))
    .filter((u) => !u.erasedAt)
    .at(0);
  if (found) return found.id;
  return newDevUser(DEV_DISPLAY_NAME);
}

/**
 * Sign a copied persona's onboarding as the user would in the app: POST /onboarding/confirm/options + /onboarding/confirm
 * (passkey-signed base rules), /mandates/options + /mandates for each seeded mandate, then /auth/recovery-codes (backup
 * codes), each assertion made by the user's dev passkey. Requests go through `app.inject` with a server-minted dev token and the caller's address, so the
 * routes' checks and rate limits apply as for the caller's own requests. Throws on any non-2xx answer.
 */
async function signSeededOnboarding(app: FastifyInstance, req: FastifyRequest, userId: string, mandates: readonly { core: MandateCore }[]): Promise<void> {
  const e = env();
  const key = await devKeyFor(userId);
  const forwarded = req.headers["x-forwarded-for"];
  const headers = { authorization: `Bearer ${await mintInternalAccessToken(userId, { dev: true })}`, ...(forwarded ? { "x-forwarded-for": forwarded } : {}) };
  const remote = req.socket?.remoteAddress ? { remoteAddress: req.socket.remoteAddress } : {};
  const post = async <T>(url: string, payload: Record<string, unknown>): Promise<T> => {
    const res = await app.inject({ method: "POST", url, headers, payload, ...remote });
    if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`${url} answered ${res.statusCode}: ${res.body.slice(0, 300)}`);
    return res.json() as T;
  };
  const sign = (challenge: string) => key.assert(challenge, { origin: e.PUBLIC_ORIGIN, rpId: e.RP_ID });
  type Options = { webauthnOptions: { challenge: string } };
  const conversationId = randomUUID();
  const rules = await post<Options & { core: unknown; challengeId: string }>("/api/onboarding/confirm/options", { conversationId });
  await post("/api/onboarding/confirm", { conversationId, challengeId: rules.challengeId, core: rules.core, assertion: sign(rules.webauthnOptions.challenge) });
  for (const { core: m } of mandates) {
    const opt = await post<Options & { core: unknown }>("/api/mandates/options", {
      payeeIds: m.payeeIds,
      categories: m.categories,
      currency: m.currency,
      maxPerPaymentMinor: m.maxPerPaymentMinor,
      maxPerPeriodMinor: m.maxPerPeriodMinor,
      period: m.period,
      validUntil: m.validUntil,
    });
    await post("/api/mandates", { core: opt.core, assertion: sign(opt.webauthnOptions.challenge) });
  }
  // Backup codes, so the copy opens on the home screen and not on the mandatory backup-codes step. Nobody sees these
  // codes: the copy is signed in with the dev login only.
  const gate = await app.inject({ method: "POST", url: "/api/auth/recovery-codes", headers, payload: {}, ...remote });
  if (gate.statusCode !== 428) throw new Error(`/api/auth/recovery-codes answered ${gate.statusCode}: ${gate.body.slice(0, 300)}`);
  const { details } = gate.json() as { details: { challengeId: string; webauthnOptions: { challenge: string } } };
  await post("/api/auth/recovery-codes", { challengeId: details.challengeId, assertion: sign(details.webauthnOptions.challenge) });
}

/** Judge build sign-in: a private persona copy (onboarded) for `demoClaim`, else a brand-new user. Never a shared account. */
async function judgeLoginUser(app: FastifyInstance, req: FastifyRequest, demoClaim: true | string | undefined): Promise<string> {
  if (!demoClaim) return newDevUser(DEV_FRESH_DISPLAY_NAME);
  const { userId, copy } = await judgeDemoCopy(demoClaim);
  // Dev convenience, as for the other dev users: AI consent given, so the chat works right away.
  await getDb().update(users).set({ aiConsentAt: clock.now() }).where(eq(users.id, userId));
  try {
    await signSeededOnboarding(app, req, userId, copy.mandates ?? []);
    // The copy opens as an account in use for a while: its seeded mandates in effect (mandates/service.ts).
    await activateJudgeCopyMandates(userId);
  } catch (err) {
    // The copy stays usable; the app then opens on onboarding, where the user can sign the rules themselves.
    req.log.error({ err, userId }, "judge build: signing the copied persona's onboarding failed");
  }
  return userId;
}

const DevLoginBody = z.object({
  client: ClientKind,
  /** Dev mode: a brand-new user (onboarding from the start) instead of the reused "Dev" user. */
  fresh: z.boolean().optional(),
  /** Demo mode: the seeded demo account (`true` = the hero, a string = that persona key), no platform passkey. */
  demoClaim: z.union([z.literal(true), z.string().regex(/^[a-z0-9-]{1,32}$/)]).optional(),
});

const devRoutes: FastifyPluginAsyncZod = async (app) => {
  if (env().NODE_ENV === "production" && !judgeModeActive()) return;

  app.post(
    "/auth/dev/login",
    { schema: { body: DevLoginBody, response: { 200: AuthSessionResponse } } },
    async (req, reply) => {
      assertAllowed();
      const { demoClaim, fresh } = req.body;
      const userId = judgeModeActive()
        ? await judgeLoginUser(app, req, demoClaim)
        : demoClaim
          ? await demoClaimUserId(demoClaim)
          : fresh
            ? await newDevUser(DEV_FRESH_DISPLAY_NAME)
            : await devUser();
      await devKeyFor(userId);
      await audit("AUTH_LOGIN_SUCCEEDED", { userId, client: req.body.client, method: "DEV_LOGIN" });
      return sessionBody(userId, await startSession(reply, userId, req.body.client, { dev: true }));
    },
  );

  // A WebAuthn assertion over a 428 challenge, signed by the caller's server-held dev passkey: dev sessions only.
  app.post(
    "/auth/dev/assert",
    { preHandler: requireUser, schema: { body: z.object({ challenge: z.string().min(16).max(256) }) } },
    async (req) => {
      assertAllowed();
      if (req.session?.scope === "lite") throw new HttpProblem(403, "LITE_SESSION", "A KassaLite device cannot approve");
      if (req.session?.dev !== true) throw new HttpProblem(403, "NOT_DEV_SESSION", "Only a dev sign-in session can use the server-held dev passkey");
      const e = env();
      const key = await devKeyFor(userIdOf(req));
      return { assertion: key.assert(req.body.challenge, { origin: e.PUBLIC_ORIGIN, rpId: e.RP_ID }) };
    },
  );
};

export default devRoutes;
