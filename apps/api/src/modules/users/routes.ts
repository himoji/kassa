/*
 * GET /me, PATCH /me (GDPR Art. 16), PATCH /settings, GET /caps, GET /rule-changes, POST /freeze,
 * POST /unfreeze (I8 loosening), POST /devices(/shortcut), GET /devices, DELETE /devices/:id, POST /onboarding/confirm/options,
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
  monthlyIncomeOf,
  type BaseRulesCore,
  type MandateOptionsRequest,
  type OnboardingProfileDraft,
} from "@kassa/shared";
import { and, asc, desc, eq, inArray, isNull, max, ne, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { demoState, devices, obligations, payees, profiles, ruleChanges, SHORTCUT_ATTEMPTS_KEPT, transactions, users } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { auditAssertionFailure, ownedNotFound } from "../../http/audit.ts";
import { conflict, HttpProblem } from "../../http/problem.ts";
import { putGated, takeGated } from "../auth/challenges.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { coolingOn } from "../demo/cooling.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { toHome } from "../money/fx.ts";
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

/** The onboarding module, if present (optional exports). */
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

const ShortcutDevicesResponse = z.object({
  devices: z.array(z.object({ id: z.string().uuid(), kind: z.literal("IOS_SHORTCUT"), createdAt: z.string(), lastUsedAt: z.string().nullable() })),
  lastCaptureAt: z.string().nullable(),
  /** Newest `lastUsedAt` of the listed devices: a Shortcut reached Kassa (a purchase or a test run). */
  lastUsedAt: z.string().nullable(),
  /** That device's last request: which fields arrived and what came of it (KassaLite's tap check). */
  lastCheck: z
    .object({
      at: z.string(),
      kind: z.enum(["TEST", "PAYMENT", "FORWARDED", "INCOMPLETE"]),
      via: z.enum(["action", "shortcut"]),
      fields: z.object({ merchant: z.boolean(), amount: z.boolean(), card: z.boolean(), place: z.boolean() }),
      status: z.enum(["LOGGED", "MERGED", "IGNORED_INCOMING", "UNPARSED"]).nullable(),
      transactionId: z.string().nullable(),
    })
    .nullable(),
  /**
   * (added 2026-10-18) The newest requests made with any of the user's Shortcut tokens, revoked ones included, refused
   * requests too (the live Shortcut test). `payment`: what was logged, as the Shortcut sent it.
   */
  recentChecks: z.array(
    z.object({
      at: z.string(),
      deviceId: z.string().uuid(),
      kind: z.enum(["TEST", "PAYMENT", "FORWARDED", "INCOMPLETE", "REVOKED_KEY", "BAD_BODY", "FAILED"]),
      via: z.enum(["action", "shortcut"]),
      client: z.string().nullable(),
      fields: z.object({ merchant: z.boolean(), amount: z.boolean(), card: z.boolean(), place: z.boolean() }),
      status: z.enum(["LOGGED", "MERGED", "IGNORED_INCOMING", "UNPARSED"]).nullable(),
      problem: z.string().nullable(),
      replyTitle: z.string().nullable(),
      payment: z.object({ merchant: z.string(), amountMinor: z.number().int(), currency: z.string() }).nullable(),
    }),
  ),
  /** (added 2026-10-18) The server's clock, so the live test counts only requests after its own start. */
  serverTime: z.string(),
});

/**
 * The planner's salary edit: the first monthly income in the home currency gets the new amount; without one, a
 * "Salary" income is added first. No edit → incomes as drafted.
 */
function withMonthlySalary(incomes: OnboardingProfileDraft["incomes"], amountMinor: number | undefined, currency: string): OnboardingProfileDraft["incomes"] {
  if (amountMinor === undefined) return incomes;
  const i = incomes.findIndex((x) => x.cadence === "MONTHLY" && x.currency === currency);
  if (i >= 0) return incomes.map((x, j) => (j === i ? { ...x, amountMinor } : x));
  return [{ source: "Salary", currency, amountMinor, cadence: "MONTHLY", nextDate: null }, ...incomes];
}

/** Per month in the home currency (the review planner's start): incomes, and recurring bills (a term bill over 6 months). */
async function planBasis(draft: OnboardingProfileDraft, homeCurrency: string): Promise<{ monthlyIncomeMinor: number; fixedMonthlyMinor: number }> {
  const now = clock.now();
  const home = async (amountMinor: number, currency: string) => {
    if (amountMinor === 0) return 0;
    try {
      return (await toHome(amountMinor, currency, homeCurrency, now)).amountMinor;
    } catch {
      return 0; // no rate for it today: left out, the user can still set the salary on the sheet
    }
  };
  let monthlyIncomeMinor = 0;
  for (const i of draft.incomes) monthlyIncomeMinor += await home(monthlyIncomeOf(i.amountMinor, i.cadence), i.currency);
  let fixedMonthlyMinor = 0;
  for (const o of draft.obligations) {
    const perMonth = o.recurrence === "MONTHLY" ? o.amountMinor : o.recurrence === "TERM" ? Math.round(o.amountMinor / 6) : 0;
    fixedMonthlyMinor += await home(perMonth, o.currency);
  }
  return { monthlyIncomeMinor, fixedMonthlyMinor };
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  async function me(userId: string) {
    const db = getDb();
    const { user, profile } = await loadUser(db, userId);
    const e = env();
    const ds = e.DEMO_ENABLED ? (await db.select({ agentMode: demoState.agentMode }).from(demoState).where(eq(demoState.id, 1)))[0] : undefined;
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
        ? { agentMode: ds?.agentMode ?? e.AGENT_MODE, clockOffsetMs: clock.offsetMs(), clockMode: clock.mode(), now: clock.now().toISOString(), coolingOff: !(await coolingOn(user.id, db)) }
        : null,
      onboarded: profile.baseRulesSignedAt !== null,
      aiNotice: aiNotice(user.region),
      aiConsentAt: user.aiConsentAt?.toISOString() ?? null,
      restrictedAt: user.restrictedAt?.toISOString() ?? null,
      accountType: user.accountType,
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

  /*
   * Expo push token of this app install. Re-registering one's own token is idempotent (and un-revokes it); a token
   * already registered to another user is never moved over (409 DEVICE_TOKEN_TAKEN, the row stays as it is), so
   * nobody can redirect another user's notifications to their own account by replaying a push token.
   */
  app.post("/devices", { schema: { body: RegisterDeviceRequest } }, async (req, reply) => {
    const userId = userIdOf(req);
    const tokenHash = sha256Base64url(req.body.expoPushToken);
    const rows = await getDb()
      .insert(devices)
      .values({ userId, kind: "APP", tokenHash, pushToken: req.body.expoPushToken, platform: req.body.platform })
      .onConflictDoUpdate({ target: devices.tokenHash, set: { revokedAt: null }, setWhere: eq(devices.userId, userId) })
      .returning({ id: devices.id });
    if (rows.length === 0) throw conflict("DEVICE_TOKEN_TAKEN", "This push token is registered to another account");
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

  /*
   * Shortcut devices (Settings → "Apple Pay → Kassa"). Each carries `lastUsedAt` (the token reached
   * /capture/shortcut: a purchase or a test run); the list also carries the newest Shortcut capture of the user
   * (`lastCaptureAt`). KassaLite's setup check waits for `lastUsedAt` to move. Revoked tokens are not listed.
   */
  app.get("/devices", { schema: { response: { 200: ShortcutDevicesResponse } } }, async (req) => {
    const userId = userIdOf(req);
    const db = getDb();
    const rows = await db
      .select({ id: devices.id, createdAt: devices.createdAt, lastUsedAt: devices.lastUsedAt, lastCheck: devices.lastCheck })
      .from(devices)
      .where(and(eq(devices.userId, userId), eq(devices.kind, "IOS_SHORTCUT"), isNull(devices.revokedAt)))
      .orderBy(desc(devices.createdAt));
    const last = (
      await db
        .select({ at: max(transactions.createdAt) })
        .from(transactions)
        .where(and(eq(transactions.userId, userId), eq(transactions.source, "SHORTCUT")))
    )[0]?.at;
    const newest = rows.reduce<(typeof rows)[number] | null>((m, r) => (r.lastUsedAt && (!m?.lastUsedAt || r.lastUsedAt > m.lastUsedAt) ? r : m), null);
    const used = newest?.lastUsedAt ?? null;
    // Every token's recent requests, revoked tokens included: an old key still in the Shortcut is a common fault.
    const all = await db
      .select({ id: devices.id, recent: devices.recentChecks })
      .from(devices)
      .where(and(eq(devices.userId, userId), eq(devices.kind, "IOS_SHORTCUT")));
    const recent = all
      .flatMap((d) => (d.recent ?? []).map((a) => ({ ...a, deviceId: d.id })))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, SHORTCUT_ATTEMPTS_KEPT);
    const txIds = [...new Set(recent.map((a) => a.transactionId).filter((id): id is string => !!id))];
    const txs = txIds.length
      ? await db
          .select({ id: transactions.id, merchant: transactions.merchantRaw, amountMinor: transactions.amountMinor, currency: transactions.currency })
          .from(transactions)
          .where(and(eq(transactions.userId, userId), inArray(transactions.id, txIds)))
      : [];
    const txById = new Map(txs.map((t) => [t.id, t]));
    return {
      devices: rows.map((r) => ({ id: r.id, kind: "IOS_SHORTCUT" as const, createdAt: r.createdAt.toISOString(), lastUsedAt: r.lastUsedAt?.toISOString() ?? null })),
      lastCaptureAt: last ? new Date(last).toISOString() : null,
      lastUsedAt: used?.toISOString() ?? null,
      lastCheck: newest?.lastCheck ?? null,
      recentChecks: recent.map((a) => {
        const tx = a.transactionId ? txById.get(a.transactionId) : undefined;
        return {
          at: a.at,
          deviceId: a.deviceId,
          kind: a.kind,
          via: a.via,
          client: a.client,
          fields: a.fields,
          status: a.status,
          problem: a.problem ?? null,
          replyTitle: a.replyTitle ?? null,
          payment: tx ? { merchant: tx.merchant, amountMinor: Number(tx.amountMinor), currency: tx.currency } : null,
        };
      }),
      serverTime: clock.now().toISOString(),
    };
  });

  // Revoking is a tightening (I8): instant, no passkey. The token 401s on /capture/shortcut from now on. Idempotent.
  app.delete(
    "/devices/:id",
    { schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req, reply) => {
      const userId = userIdOf(req);
      const db = getDb();
      const id = req.params.id;
      const own = and(eq(devices.id, id), eq(devices.userId, userId), eq(devices.kind, "IOS_SHORTCUT"));
      const found = await db.transaction(async (tx) => {
        const r = await tx
          .update(devices)
          .set({ revokedAt: clock.now() })
          .where(and(own, isNull(devices.revokedAt)))
          .returning({ id: devices.id });
        if (r.length > 0) {
          await ledger.append("DEVICE_TOKEN_REVOKED", { userId, deviceId: id, kind: "IOS_SHORTCUT" }, tx);
          return true;
        }
        return (await tx.select({ id: devices.id }).from(devices).where(own)).length > 0; // already revoked
      });
      // Another user's device answers like an unknown one (API1), audited as AUTHZ_DENIED.
      if (!found) throw await ownedNotFound(userId, "device", id, async () => (await db.select({ id: devices.id }).from(devices).where(eq(devices.id, id))).length > 0);
      return reply.status(204).send();
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
      const stored = (await ob.getOnboardingDraft?.(userId, req.body.conversationId)) ?? emptyDraft();
      // Review-sheet edits: new limits for the draft's own budget categories (others are ignored), budgets the user
      // added by hand (categories the draft lacks; at most 20 in all), the planner's monthly salary, and the caps.
      const budgetEdits = new Map((req.body.budgets ?? []).map((b) => [b.category, b.limitHomeMinor]));
      const own = new Set(stored.budgets.map((b) => b.category));
      const added = (req.body.addedBudgets ?? []).filter((b, i, all) => !own.has(b.category) && all.findIndex((x) => x.category === b.category) === i);
      const draft = {
        ...stored,
        budgets: [...stored.budgets.map((b) => ({ ...b, limitHomeMinor: budgetEdits.get(b.category) ?? b.limitHomeMinor })), ...added].slice(0, 20),
        incomes: withMonthlySalary(stored.incomes, req.body.monthlyIncomeMinor, stored.homeCurrency ?? user.homeCurrency),
      };
      const capEdits = Object.fromEntries(Object.entries(req.body.caps ?? {}).filter(([, v]) => v !== undefined));
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
        caps: { currency: draft.homeCurrency ?? user.homeCurrency, ...caps, ...capEdits },
      };
      const rulesHash = jcsHash(core);
      const challengeId = await putGated({ userId, purpose: "base-rules", hash: rulesHash, payload: { core, draft } });

      const { suggestedMandate, suggestedMandatePayees } = await suggestRentMandate(userId);
      return {
        core,
        rulesHash,
        challengeId,
        webauthnOptions: await assertionOptions(db, userId, rulesHash),
        draft,
        suggestedMandate,
        suggestedMandatePayees,
        planBasis: await planBasis(draft, core.settings.homeCurrency),
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
      const gated = await takeGated(req.body.challengeId, userId, "base-rules");
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
