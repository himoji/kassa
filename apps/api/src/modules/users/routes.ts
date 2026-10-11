/*
 * GET /me, PATCH /me (GDPR Art. 16), PATCH /settings, GET /caps, GET /rule-changes, POST /freeze,
 * POST /unfreeze (I8 loosening), POST /devices(/shortcut), POST /onboarding/confirm/options,
 * POST /onboarding/confirm (contracts: @kassa/shared dto.ts + appDto.ts + privacyDto.ts).
 */
import {
  CapsResponse,
  FreezeResponse,
  jcs,
  MeResponse,
  OnboardingConfirmOptionsRequest,
  OnboardingConfirmOptionsResponse,
  OnboardingConfirmRequest,
  OnboardingConfirmResponse,
  RegisterDeviceRequest,
  RuleChangesResponse,
  SettingsPatchRequest,
  UnfreezeRequest,
  UnfreezeResponse,
  UpdateMeRequest,
  SettingsPatchResponse,
  sha256Base64url,
  jcsHash,
  type BaseRulesCore,
  type MandateOptionsRequest,
  type OnboardingProfileDraft,
} from "@kassa/shared";
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { demoState, devices, obligations, payees, profiles, ruleChanges, users } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { auditAssertionFailure } from "../../http/audit.ts";
import { conflict, HttpProblem } from "../../http/problem.ts";
import { putGated, takeGated } from "../auth/challenges.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { aiNotice } from "../privacy/notice.ts";
import { rectifyDisplayName } from "../privacy/service.ts";
import { assertionOptions, verifyRulesAssertion } from "../rules/webauthn.ts";
import { effectiveOf, loadUser, settingsOf } from "./service.ts";
import { patchSettings } from "./settings.ts";
import { cancelPendingUnfreezes, requestUnfreeze } from "./unfreeze.ts";

type OnboardingModule = {
  getOnboardingDraft?: (userId: string, conversationId: string) => Promise<OnboardingProfileDraft | null>;
  applyOnboardingDraft?: (userId: string, draft: OnboardingProfileDraft) => Promise<void>;
};

/** Track B's onboarding module, if present (optional exports; see PHASE1_COORDINATION.md). */
async function onboardingModule(): Promise<OnboardingModule> {
  try {
    const path = new URL("../onboarding/index.ts", import.meta.url).href;
    return (await import(/* @vite-ignore */ path)) as OnboardingModule;
  } catch {
    return {};
  }
}

function emptyDraft(): OnboardingProfileDraft {
  return {
    displayName: null,
    homeCurrency: null,
    region: null,
    preset: null,
    moneyMode: null,
    notificationMode: null,
    incomes: [],
    obligations: [],
    budgets: [],
    cards: [],
  };
}

/**
 * The rent mandate onboarding offers (spec §18 seed: rent mandate): a landlord with a monthly bill. The payee may still
 * be COOLING, also without account details (bills from the onboarding chat): the mandate is signed now, but the rules
 * refuse every payment to that payee until it has a verified account (I7, PAYEE_ACCOUNT_MISSING). BLOCKED never.
 */
async function suggestRentMandate(userId: string): Promise<{ suggestedMandate: MandateOptionsRequest | null; suggestedMandatePayees: { id: string; name: string }[] }> {
  const rent = (
    await getDb()
      .select({ o: obligations, p: payees })
      .from(obligations)
      .innerJoin(payees, eq(payees.id, obligations.payeeId))
      .where(and(eq(obligations.userId, userId), eq(obligations.recurrence, "MONTHLY"), eq(payees.kind, "LANDLORD"), ne(payees.status, "BLOCKED")))
      .orderBy(desc(sql`${payees.status} = 'VERIFIED'`), asc(obligations.dueDate))
  )[0];
  if (!rent) return { suggestedMandate: null, suggestedMandatePayees: [] };
  // Headroom of ~11% over the bill, rounded up to a whole major unit (e.g. HUF 180,000 → 200,000).
  const cap = Math.ceil((rent.o.amountMinor * 10) / 9 / 1_000_000) * 1_000_000;
  return {
    suggestedMandate: {
      payeeIds: [rent.p.id],
      categories: [rent.o.category],
      currency: rent.o.currency,
      maxPerPaymentMinor: cap,
      maxPerPeriodMinor: cap,
      period: "MONTH",
      validUntil: null,
    },
    suggestedMandatePayees: [{ id: rent.p.id, name: rent.p.name }],
  };
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  async function me(userId: string) {
    const db = getDb();
    const { user, profile } = await loadUser(db, userId);
    const e = env();
    const ds = e.DEMO_ENABLED ? (await db.select().from(demoState).where(eq(demoState.id, 1)))[0] : undefined;
    const effective = effectiveOf(user);
    return {
      id: user.id,
      displayName: user.displayName,
      homeCurrency: user.homeCurrency,
      region: user.region,
      preset: user.preset,
      moneyMode: effective.moneyMode,
      notificationMode: profile.notificationMode,
      frozenAt: user.frozenAt?.toISOString() ?? null,
      settings: settingsOf(user, profile.notificationMode),
      effective,
      demo: e.DEMO_ENABLED
        ? { agentMode: ds?.agentMode ?? e.AGENT_MODE, clockOffsetMs: clock.offsetMs(), now: clock.now().toISOString() }
        : null,
      onboarded: profile.baseRulesSignedAt !== null,
      aiNotice: aiNotice(user.region),
      aiConsentAt: user.aiConsentAt?.toISOString() ?? null,
      restrictedAt: user.restrictedAt?.toISOString() ?? null,
    };
  }

  app.get("/me", { schema: { response: { 200: MeResponse } } }, async (req) => me(userIdOf(req)));

  // GDPR Art. 16 rectification (the name is the only free-form profile field; settings use PATCH /settings).
  app.patch("/me", { schema: { body: UpdateMeRequest, response: { 200: MeResponse } } }, async (req) => {
    const userId = userIdOf(req);
    await rectifyDisplayName(userId, req.body.displayName);
    return me(userId);
  });

  app.patch("/settings", { schema: { body: SettingsPatchRequest, response: { 200: SettingsPatchResponse } } }, async (req) =>
    patchSettings(userIdOf(req), req.body as never),
  );

  app.get("/caps", { schema: { response: { 200: CapsResponse } } }, async (req) => {
    const { user, caps } = await loadUser(getDb(), userIdOf(req));
    return { caps: { currency: user.homeCurrency, ...caps } };
  });

  app.get(
    "/rule-changes",
    { schema: { querystring: z.object({ status: z.enum(["pending", "all"]).default("pending") }), response: { 200: RuleChangesResponse } } },
    async (req) => {
      const userId = userIdOf(req);
      const rows = await getDb()
        .select()
        .from(ruleChanges)
        .where(
          req.query.status === "pending"
            ? and(eq(ruleChanges.userId, userId), isNull(ruleChanges.appliedAt), isNull(ruleChanges.canceledAt))
            : eq(ruleChanges.userId, userId),
        )
        .orderBy(desc(ruleChanges.createdAt));
      return {
        changes: rows
          .filter((r) => r.effectiveAt !== null)
          .map((r) => ({
            id: r.id,
            kind: r.kind,
            direction: r.direction,
            before: r.before,
            after: r.after,
            createdAt: r.createdAt.toISOString(),
            effectiveAt: r.effectiveAt!.toISOString(),
            appliedAt: r.appliedAt?.toISOString() ?? null,
          })),
      };
    },
  );

  // Freeze is a tightening: instant, no passkey (I8).
  app.post("/freeze", { schema: { response: { 200: FreezeResponse } } }, async (req) => {
    const userId = userIdOf(req);
    const db = getDb();
    const now = clock.now();
    const rows = await db.transaction(async (tx) => {
      const r = await tx.update(users).set({ frozenAt: now }).where(and(eq(users.id, userId), isNull(users.frozenAt))).returning();
      if (r.length > 0) await ledger.append("ACCOUNT_FROZEN", { userId }, tx);
      // Freezing again while an unfreeze is pending cancels it (tightening wins, I8).
      await cancelPendingUnfreezes(tx, userId);
      return r;
    });
    const frozenAt = rows[0]?.frozenAt ?? (await loadUser(db, userId)).user.frozenAt ?? now;
    return { frozenAt: frozenAt.toISOString() };
  });

  // Unfreeze is a loosening (I8, DECISIONS 2026-10-11): passkey over a fresh challenge, effective after 24 h.
  app.post("/unfreeze", { schema: { body: UnfreezeRequest, response: { 200: UnfreezeResponse } } }, async (req) =>
    requestUnfreeze(userIdOf(req), req.body),
  );

  // Expo push token of this app install.
  app.post("/devices", { schema: { body: RegisterDeviceRequest } }, async (req, reply) => {
    const userId = userIdOf(req);
    const tokenHash = sha256Base64url(req.body.expoPushToken);
    await getDb()
      .insert(devices)
      .values({ userId, kind: "APP", tokenHash, pushToken: req.body.expoPushToken, platform: req.body.platform })
      .onConflictDoUpdate({ target: devices.tokenHash, set: { userId, revokedAt: null } });
    return reply.status(204).send();
  });

  // iOS Shortcut bearer token (I13): returned once, only its hash is stored.
  app.post(
    "/devices/shortcut",
    { schema: { response: { 201: z.object({ deviceId: z.string().uuid(), token: z.string() }) } } },
    async (req, reply) => {
      const userId = userIdOf(req);
      const token = `ksc_${randomBytes(32).toString("base64url")}`;
      const rows = await getDb()
        .insert(devices)
        .values({ userId, kind: "IOS_SHORTCUT", tokenHash: sha256Base64url(token) })
        .returning({ id: devices.id });
      await ledger.append("DEVICE_TOKEN_CREATED", { userId, deviceId: rows[0]!.id, kind: "IOS_SHORTCUT" });
      return reply.status(201).send({ deviceId: rows[0]!.id, token });
    },
  );

  // ---------- onboarding confirm (passkey-signed base rules) ----------

  app.post(
    "/onboarding/confirm/options",
    { schema: { body: OnboardingConfirmOptionsRequest, response: { 200: OnboardingConfirmOptionsResponse } } },
    async (req) => {
      const userId = userIdOf(req);
      const db = getDb();
      const { user, profile, caps } = await loadUser(db, userId);
      const ob = await onboardingModule();
      const draft = (await ob.getOnboardingDraft?.(userId, req.body.conversationId)) ?? emptyDraft();
      const current = settingsOf(user, profile.notificationMode);
      const core: BaseRulesCore = {
        v: 1,
        userId,
        settings: {
          preset: draft.preset ?? current.preset,
          region: draft.region ?? current.region,
          homeCurrency: draft.homeCurrency ?? current.homeCurrency,
          notificationMode: draft.notificationMode ?? current.notificationMode,
          overrides: { ...current.overrides, ...(draft.moneyMode ? { moneyMode: draft.moneyMode } : {}) },
        },
        caps: { currency: draft.homeCurrency ?? user.homeCurrency, ...caps },
      };
      const rulesHash = jcsHash(core);
      const challengeId = putGated({ userId, purpose: "base-rules", hash: rulesHash, payload: { core, draft } });

      const { suggestedMandate, suggestedMandatePayees } = await suggestRentMandate(userId);
      return {
        core,
        rulesHash,
        challengeId,
        webauthnOptions: await assertionOptions(db, userId, rulesHash),
        draft,
        suggestedMandate,
        suggestedMandatePayees,
      };
    },
  );

  app.post(
    "/onboarding/confirm",
    { schema: { body: OnboardingConfirmRequest, response: { 200: OnboardingConfirmResponse } } },
    async (req) => {
      const userId = userIdOf(req);
      const db = getDb();
      const { profile } = await loadUser(db, userId);
      if (profile.baseRulesSignedAt) throw conflict("ALREADY_ONBOARDED", "Base rules already signed; change them in Settings (I8)");
      const gated = takeGated(req.body.challengeId, userId, "base-rules");
      const pending = gated?.payload as { core: BaseRulesCore; draft: OnboardingProfileDraft } | undefined;
      if (!gated || !pending || jcs(pending.core) !== jcs(req.body.core)) {
        throw new HttpProblem(409, "CHALLENGE_MISMATCH", "Signed rules differ from the server's; reload the review");
      }
      const check = await verifyRulesAssertion(db, { userId, assertion: req.body.assertion, expectedChallenge: gated.hash, challengeReason: "ASSERTION_INVALID" });
      if (!check.ok) {
        await auditAssertionFailure(userId, "base-rules", check.reason);
        throw new HttpProblem(403, "PASSKEY_REQUIRED", check.detail, { reasonCodes: ["PASSKEY_REQUIRED", check.reason] });
      }
      const core = pending.core;
      const now = clock.now();
      const { currency: _currency, ...caps } = core.caps;
      await db.transaction(async (tx) => {
        const eff = effectiveOf({ ...(await loadUser(tx, userId)).user, preset: core.settings.preset, overrides: core.settings.overrides });
        await tx
          .update(users)
          .set({
            preset: core.settings.preset,
            region: core.settings.region,
            homeCurrency: core.settings.homeCurrency,
            overrides: core.settings.overrides,
            moneyMode: eff.moneyMode,
          })
          .where(eq(users.id, userId));
        await tx
          .update(profiles)
          .set({
            notificationMode: core.settings.notificationMode,
            caps,
            baseRules: core as unknown as Record<string, unknown>,
            baseRulesHash: gated.hash,
            baseRulesAssertion: req.body.assertion as never,
            baseRulesSignedAt: now,
          })
          .where(eq(profiles.userId, userId));
        await ledger.append("BASE_RULES_SIGNED", { userId, baseRulesHash: gated.hash, credentialId: check.credentialId }, tx);
      });
      const ob = await onboardingModule();
      if (ob.applyOnboardingDraft) await ob.applyOnboardingDraft(userId, pending.draft);
      // Step 2 of onboarding (rent mandate): computed now, because a new user's rent bill only exists once the
      // draft is applied above.
      return { onboarded: true as const, ...(await suggestRentMandate(userId)) };
    },
  );
};

export default routes;
