import { AuthSessionResponse, ClientKind } from "@kassa/shared";
import { eq } from "drizzle-orm";
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
import { demoClaimUserId } from "./demoClaim.ts";
import { requireUser, sessionBody, startSession, userIdOf } from "./session.ts";
import { SoftAuthenticator } from "./soft-authenticator.ts";

/*
 * Dev sign-in (local development and phone testing through a tunnel, where a passkey is a dead end: a quick tunnel's
 * host changes every run, so passkeys bound to it never work twice).
 *
 * POST /auth/dev/login creates (or reuses) a "Dev" user with a server-held software passkey and starts a session
 * carrying `dev: true`. The app's two modes pick the account: dev mode (`fresh`) makes a brand-new user every time,
 * so onboarding starts from scratch; demo mode (`demoClaim`, as in the demo-claim registration) enters a seeded demo
 * persona without a platform passkey. Approvals still go through the normal WebAuthn checks: POST /auth/dev/assert signs the 428
 * challenge with a server-held key. Dev sessions use it for every approval; any other session (a real passkey user)
 * only when the app's "Dev" button next to a passkey button asks for it, and the key is then registered on that
 * account too. KassaLite sessions never get it (they never get passkey-gated rights). Nothing else in the passkey
 * verification changes.
 *
 * Guards, all required: the routes are not registered when NODE_ENV=production; each request also needs
 * DEMO_ENABLED and DEV_LOGIN, and RP_ID must be localhost, a *.trycloudflare.com quick tunnel or PHONE_HOST.
 */

export const DEV_DISPLAY_NAME = "Dev";
/** Dev mode users: a new one per sign-in, never reused (the reused "Dev" user is looked up by its name). */
export const DEV_FRESH_DISPLAY_NAME = "Dev (fresh)";

/** One software passkey per dev user, for this process (a restart registers a fresh one on the next use). */
const devKeys = new Map<string, SoftAuthenticator>();

export function devLoginAllowed(): boolean {
  const e = env();
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

const DevLoginBody = z.object({
  client: ClientKind,
  /** Dev mode: a brand-new user (onboarding from the start) instead of the reused "Dev" user. */
  fresh: z.boolean().optional(),
  /** Demo mode: the seeded demo account (`true` = the hero, a string = that persona key), no platform passkey. */
  demoClaim: z.union([z.literal(true), z.string().regex(/^[a-z0-9-]{1,32}$/)]).optional(),
});

const devRoutes: FastifyPluginAsyncZod = async (app) => {
  if (env().NODE_ENV === "production") return;

  app.post(
    "/auth/dev/login",
    { schema: { body: DevLoginBody, response: { 200: AuthSessionResponse } } },
    async (req, reply) => {
      assertAllowed();
      const { demoClaim, fresh } = req.body;
      const userId = demoClaim ? await demoClaimUserId(demoClaim) : fresh ? await newDevUser(DEV_FRESH_DISPLAY_NAME) : await devUser();
      await devKeyFor(userId);
      await audit("AUTH_LOGIN_SUCCEEDED", { userId, client: req.body.client, method: "DEV_LOGIN" });
      return sessionBody(userId, await startSession(reply, userId, req.body.client, { dev: true }));
    },
  );

  // A WebAuthn assertion over a 428 challenge, signed by the caller's server-held dev passkey (not for KassaLite).
  app.post(
    "/auth/dev/assert",
    { preHandler: requireUser, schema: { body: z.object({ challenge: z.string().min(16).max(256) }) } },
    async (req) => {
      assertAllowed();
      if (req.session?.scope === "lite") throw new HttpProblem(403, "LITE_SESSION", "A KassaLite device cannot approve");
      const e = env();
      const key = await devKeyFor(userIdOf(req));
      return { assertion: key.assert(req.body.challenge, { origin: e.PUBLIC_ORIGIN, rpId: e.RP_ID }) };
    },
  );
};

export default devRoutes;
