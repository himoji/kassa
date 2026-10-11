/*
 * Passkey auth (spec §8) with the @kassa/shared appDto contract (Track C). Registration writes the
 * credential to BOTH tables (spec §7): webauthn_credentials_rules here, webauthn_credentials_payments
 * through the payments module. Adding a second device requires an assertion from an existing passkey.
 */
import {
  AuthenticationResponseJSON,
  AuthSessionResponse,
  LoginOptionsResponse,
  LoginVerifyRequest,
  LogoutRequest,
  RefreshRequest,
  RefreshResponse,
  RegisterOptionsRequest,
  RegisterOptionsResponse,
  RegisterVerifyRequest,
} from "@kassa/shared";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { demoState, profiles, users, webauthnCredentialsRules } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { HttpProblem } from "../../http/problem.ts";
import { ledger } from "../ledger/index.ts";
import { registerPaymentsCredential } from "../payments/credentials.ts";
import { verifyRulesAssertion } from "../rules/webauthn.ts";
import { createUser } from "../users/service.ts";
import { putChallenge, takeChallenge } from "./challenges.ts";
import { authenticate, endSession, refreshSession, revokeRefresh, startSession } from "./session.ts";

async function sessionBody(userId: string, tokens: Awaited<ReturnType<typeof startSession>>) {
  const db = getDb();
  const u = (await db.select({ id: users.id, displayName: users.displayName }).from(users).where(eq(users.id, userId)))[0];
  if (!u) throw new HttpProblem(404, "NOT_FOUND", "user not found");
  const p = (await db.select({ signedAt: profiles.baseRulesSignedAt }).from(profiles).where(eq(profiles.userId, userId)))[0];
  return { user: u, onboarded: Boolean(p?.signedAt), tokens };
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/auth/register/options",
    {
      schema: {
        // (extension) demoClaim: bind the first passkey to the seeded hero user when DEMO_ENABLED.
        body: RegisterOptionsRequest.extend({ demoClaim: z.boolean().optional() }),
        response: { 200: RegisterOptionsResponse.extend({ requiresExistingAssertion: z.boolean() }) },
      },
    },
    async (req) => {
      const db = getDb();
      const e = env();
      const current = await authenticate(req);
      let userId: string;
      let existingUser = false;
      if (current) {
        userId = current;
        existingUser = true;
      } else if (req.body.demoClaim && e.DEMO_ENABLED) {
        const ds = (await db.select().from(demoState).where(eq(demoState.id, 1)))[0];
        if (!ds?.demoUserId) throw new HttpProblem(409, "DEMO_NOT_SEEDED", "Run the seed first");
        const creds = await db
          .select({ id: webauthnCredentialsRules.id })
          .from(webauthnCredentialsRules)
          .where(eq(webauthnCredentialsRules.userId, ds.demoUserId));
        if (creds.length > 0) throw new HttpProblem(409, "DEMO_ALREADY_CLAIMED", "Sign in with the existing passkey");
        userId = ds.demoUserId;
        existingUser = true;
      } else {
        userId = randomUUID();
      }
      const existing = existingUser
        ? await db
            .select({ id: webauthnCredentialsRules.credentialId, transports: webauthnCredentialsRules.transports })
            .from(webauthnCredentialsRules)
            .where(eq(webauthnCredentialsRules.userId, userId))
        : [];
      const options = await generateRegistrationOptions({
        rpName: e.RP_NAME,
        rpID: e.RP_ID,
        userName: req.body.displayName,
        userDisplayName: req.body.displayName,
        userID: new TextEncoder().encode(userId),
        attestationType: "none",
        excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      });
      const challengeId = putChallenge(options.challenge, {
        purpose: "register",
        userId,
        displayName: req.body.displayName,
        existingUser,
      });
      return { challengeId, options: options as never, requiresExistingAssertion: existing.length > 0 };
    },
  );

  app.post(
    "/auth/register/verify",
    {
      schema: {
        // (extension) existingAssertion: required when adding a device (spec §7).
        body: RegisterVerifyRequest.extend({ existingAssertion: AuthenticationResponseJSON.optional() }),
        response: { 200: AuthSessionResponse },
      },
    },
    async (req, reply) => {
      const db = getDb();
      const e = env();
      const pending = takeChallenge(req.body.challengeId);
      if (!pending || pending.purpose !== "register") {
        throw new HttpProblem(400, "CHALLENGE_UNKNOWN", "Registration challenge unknown or expired");
      }
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: req.body.response as never,
          expectedChallenge: pending.challenge,
          expectedOrigin: e.origins,
          expectedRPID: e.RP_ID,
          requireUserVerification: true,
        });
      } catch (err) {
        throw new HttpProblem(400, "ASSERTION_INVALID", (err as Error).message, { reasonCodes: ["ASSERTION_INVALID"] });
      }
      if (!verification.verified) throw new HttpProblem(400, "ASSERTION_INVALID", "Registration not verified");
      const { credential } = verification.registrationInfo;

      await db.transaction(async (tx) => {
        if (pending.existingUser) {
          const existing = await tx
            .select({ id: webauthnCredentialsRules.id })
            .from(webauthnCredentialsRules)
            .where(eq(webauthnCredentialsRules.userId, pending.userId));
          if (existing.length > 0) {
            const check = await verifyRulesAssertion(tx, {
              userId: pending.userId,
              assertion: req.body.existingAssertion,
              expectedChallenge: pending.challenge,
              challengeReason: "ASSERTION_INVALID",
            });
            if (!check.ok) throw new HttpProblem(403, "PASSKEY_REQUIRED", check.detail, { reasonCodes: [check.reason] });
          }
        } else {
          await createUser(tx, { id: pending.userId, displayName: pending.displayName });
        }
        const row = {
          userId: pending.userId,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString("base64url"),
          counter: credential.counter,
          transports: credential.transports ?? [],
        };
        await tx.insert(webauthnCredentialsRules).values(row);
        await registerPaymentsCredential(tx, row);
        await ledger.append("AUTH_PASSKEY_REGISTERED", { userId: pending.userId, credentialId: credential.id, newUser: !pending.existingUser }, tx);
      });
      return sessionBody(pending.userId, await startSession(reply, pending.userId, req.body.client));
    },
  );

  app.post(
    "/auth/login/options",
    { schema: { response: { 200: LoginOptionsResponse } } },
    async () => {
      const options = await generateAuthenticationOptions({ rpID: env().RP_ID, userVerification: "required" });
      const challengeId = putChallenge(options.challenge, { purpose: "login" });
      return { challengeId, options: options as never };
    },
  );

  app.post(
    "/auth/login/verify",
    { schema: { body: LoginVerifyRequest, response: { 200: AuthSessionResponse } } },
    async (req, reply) => {
      const db = getDb();
      const e = env();
      const pending = takeChallenge(req.body.challengeId);
      if (!pending || pending.purpose !== "login") {
        throw new HttpProblem(400, "CHALLENGE_UNKNOWN", "Login challenge unknown or expired");
      }
      const cred = (
        await db.select().from(webauthnCredentialsRules).where(eq(webauthnCredentialsRules.credentialId, req.body.response.id))
      )[0];
      if (!cred) throw new HttpProblem(401, "ASSERTION_INVALID", "Unknown passkey");
      let res;
      try {
        res = await verifyAuthenticationResponse({
          response: req.body.response as never,
          expectedChallenge: pending.challenge,
          expectedOrigin: e.origins,
          expectedRPID: e.RP_ID,
          requireUserVerification: true,
          credential: {
            id: cred.credentialId,
            publicKey: new Uint8Array(Buffer.from(cred.publicKey, "base64url")),
            counter: cred.counter,
            transports: cred.transports,
          },
        });
      } catch (err) {
        throw new HttpProblem(401, "ASSERTION_INVALID", (err as Error).message);
      }
      if (!res.verified) throw new HttpProblem(401, "ASSERTION_INVALID", "Login not verified");
      await db
        .update(webauthnCredentialsRules)
        .set({ counter: res.authenticationInfo.newCounter })
        .where(eq(webauthnCredentialsRules.id, cred.id));
      return sessionBody(cred.userId, await startSession(reply, cred.userId, req.body.client));
    },
  );

  app.post(
    "/auth/refresh",
    { schema: { body: RefreshRequest, response: { 200: RefreshResponse } } },
    async (req) => {
      const r = await refreshSession(req.body.refreshToken);
      if (!r) throw new HttpProblem(401, "UNAUTHENTICATED", "Refresh token invalid, expired or already used");
      return r;
    },
  );

  app.post("/auth/logout", { schema: { body: LogoutRequest.optional() } }, async (req, reply) => {
    revokeRefresh(req.body?.refreshToken);
    endSession(reply);
    return reply.status(204).send();
  });
};

export default routes;
