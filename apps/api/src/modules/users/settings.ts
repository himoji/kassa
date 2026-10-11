/*
 * Settings and caps changes (spec §8 PATCH /settings, §10 presets, I8 "loosening is slow, tightening is
 * instant"). Each changed field is classified on its own:
 *  - LOOSEN: preset/paymentPolicy/moneyMode/agentAutonomy towards more autonomy, region CN→EU (CN forces
 *    handoff), any cap raised, the protected reserve lowered.
 *  - otherwise TIGHTEN/neutral (homeCurrency, notificationMode, lower caps, …): applied immediately.
 * Loosenings need a passkey assertion over hash(change) (HTTP 428 + PasskeyChallenge round trip, see
 * @kassa/shared SettingsPatchRequest) and are stored in rule_changes with effectiveAt = now + 24 h; the
 * scheduler applies them. An unsigned loosening is never stored and never applies.
 */
import {
  applySettingsPatch,
  effectiveSettings,
  jcs,
  jcsHash,
  type SettingsPatch,
  type UserSettings,
} from "@kassa/shared";
import { and, eq, isNull, lte } from "drizzle-orm";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { profiles, ruleChanges, users, type CapsJson } from "../../db/schema.ts";
import { HttpProblem } from "../../http/problem.ts";
import { putGated, takeGated } from "../auth/challenges.ts";
import { addMs, clock, DAY_MS } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { assertionOptions, verifyRulesAssertion } from "../rules/webauthn.ts";
import { loadUser, settingsOf } from "./service.ts";

export const LOOSEN_DELAY_MS = DAY_MS;

const RANK = {
  preset: { ASK_ME: 0, SMART: 1, AUTOPILOT: 2 },
  paymentPolicy: { ALWAYS_ASK: 0, RISK_BASED: 1, NEVER_ASK: 2 },
  moneyMode: { HANDOFF: 0, PAY_IN_PLACE: 1, CAPPED_WALLET: 2 },
  agentAutonomy: { ON_REQUEST: 0, PLAN_AHEAD: 1, PLAN_AND_ACT: 2 },
  region: { CN: 0, EU: 1 },
} as const;

export type CapsPatchIn = Partial<{
  perPaymentMinor: number;
  perDayMinor: number;
  perMonthMinor: number;
  smallAutoMinor: number;
  reserveMinor: number;
}>;

export type ChangeSet = { settings: SettingsPatch; caps: CapsPatchIn };

function autonomyLoosens(before: UserSettings, after: UserSettings): boolean {
  const eb = effectiveSettings(before.preset, before.overrides);
  const ea = effectiveSettings(after.preset, after.overrides);
  return (
    RANK.preset[after.preset] > RANK.preset[before.preset] ||
    RANK.paymentPolicy[ea.paymentPolicy] > RANK.paymentPolicy[eb.paymentPolicy] ||
    RANK.moneyMode[ea.moneyMode] > RANK.moneyMode[eb.moneyMode] ||
    RANK.agentAutonomy[ea.agentAutonomy] > RANK.agentAutonomy[eb.agentAutonomy] ||
    RANK.region[after.region] > RANK.region[before.region]
  );
}

/** Split a patch into the part applied now and the part that loosens (needs passkey + 24 h). */
export function classify(current: UserSettings, caps: CapsJson, patch: SettingsPatch, capsPatch: CapsPatchIn): { tighten: ChangeSet; loosen: ChangeSet } {
  const tighten: ChangeSet = { settings: {}, caps: {} };
  const loosen: ChangeSet = { settings: {}, caps: {} };
  const single = (p: SettingsPatch): UserSettings => {
    try {
      return applySettingsPatch(current, p);
    } catch {
      // Invalid on its own (e.g. NEVER_ASK with current HANDOFF): judge without the refinement.
      return { ...current, ...p, overrides: { ...current.overrides, ...p.overrides } } as UserSettings;
    }
  };
  for (const key of ["preset", "region", "homeCurrency", "notificationMode"] as const) {
    if (patch[key] === undefined || patch[key] === current[key]) continue;
    const p = { [key]: patch[key] } as SettingsPatch;
    (autonomyLoosens(current, single(p)) ? loosen : tighten).settings[key] = patch[key] as never;
  }
  for (const key of ["agentAutonomy", "paymentPolicy", "moneyMode"] as const) {
    const v = patch.overrides?.[key];
    if (v === undefined || v === current.overrides[key]) continue;
    const p: SettingsPatch = { overrides: { [key]: v } };
    const bucket = autonomyLoosens(current, single(p)) ? loosen : tighten;
    bucket.settings.overrides = { ...bucket.settings.overrides, [key]: v };
  }
  for (const key of ["perPaymentMinor", "perDayMinor", "perMonthMinor", "smallAutoMinor", "reserveMinor"] as const) {
    const v = capsPatch[key];
    if (v === undefined || v === caps[key]) continue;
    const loosens = key === "reserveMinor" ? v < caps[key] : v > caps[key];
    (loosens ? loosen : tighten).caps[key] = v;
  }
  return { tighten, loosen };
}

const isEmpty = (c: ChangeSet) => Object.keys(c.settings).length === 0 && Object.keys(c.caps).length === 0;

function mergeCaps(caps: CapsJson, patch: CapsPatchIn): CapsJson {
  return { ...caps, ...patch };
}

async function applyChangeSet(tx: DbOrTx, userId: string, current: UserSettings, caps: CapsJson, c: ChangeSet): Promise<UserSettings> {
  const next = applySettingsPatch(current, c.settings); // throws ZodError on an invalid combination
  const eff = effectiveSettings(next.preset, next.overrides);
  await tx
    .update(users)
    .set({ preset: next.preset, region: next.region, homeCurrency: next.homeCurrency, overrides: next.overrides, moneyMode: eff.moneyMode })
    .where(eq(users.id, userId));
  await tx
    .update(profiles)
    .set({ notificationMode: next.notificationMode, caps: mergeCaps(caps, c.caps) })
    .where(eq(profiles.userId, userId));
  return next;
}

function beforeOf(current: UserSettings, caps: CapsJson, c: ChangeSet): ChangeSet {
  const settings: Record<string, unknown> = {};
  for (const k of Object.keys(c.settings)) {
    if (k === "overrides") {
      const o: Record<string, unknown> = {};
      for (const ok of Object.keys(c.settings.overrides ?? {})) o[ok] = current.overrides[ok as keyof typeof current.overrides];
      settings.overrides = o;
    } else settings[k] = current[k as keyof UserSettings];
  }
  const capsBefore: Record<string, number> = {};
  for (const k of Object.keys(c.caps)) capsBefore[k] = caps[k as keyof CapsJson];
  return { settings: settings as SettingsPatch, caps: capsBefore };
}

export type PatchResult = {
  settings: UserSettings;
  pending: { ruleChangeId: string; kind: string; direction: "LOOSEN" | "TIGHTEN"; effectiveAt: string }[];
};

export async function patchSettings(
  userId: string,
  body: SettingsPatch & { caps?: CapsPatchIn; challengeId?: string; assertion?: unknown },
): Promise<PatchResult> {
  const db = getDb();
  const { user, profile, caps } = await loadUser(db, userId);
  const current = settingsOf(user, profile.notificationMode);
  const patch: SettingsPatch = {
    ...(body.preset !== undefined ? { preset: body.preset } : {}),
    ...(body.region !== undefined ? { region: body.region } : {}),
    ...(body.homeCurrency !== undefined ? { homeCurrency: body.homeCurrency } : {}),
    ...(body.notificationMode !== undefined ? { notificationMode: body.notificationMode } : {}),
    ...(body.overrides !== undefined ? { overrides: body.overrides } : {}),
  };
  const { tighten, loosen } = classify(current, caps, patch, body.caps ?? {});

  // The final state and the immediate state must both be valid (spec §10 refinement).
  try {
    applySettingsPatch(current, { ...tighten.settings, ...loosen.settings, overrides: { ...tighten.settings.overrides, ...loosen.settings.overrides } });
    applySettingsPatch(current, tighten.settings);
  } catch (err) {
    throw new HttpProblem(422, "INVALID_SETTINGS", "Invalid combination of settings", { details: (err as { issues?: unknown }).issues ?? String(err) });
  }

  let ruleChange: { id: string; effectiveAt: Date } | null = null;
  let assertion: unknown = null;
  let changeHash = "";
  const loosenCore = isEmpty(loosen) ? null : { v: 1, kind: "SETTINGS", userId, before: beforeOf(current, caps, loosen), after: loosen };
  if (loosenCore) {
    if (!body.challengeId || !body.assertion) {
      const hash = jcsHash(loosenCore);
      const challengeId = putGated({ userId, purpose: "settings", hash, payload: loosenCore });
      throw new HttpProblem(428, "PASSKEY_REQUIRED", "Loosening needs your passkey and takes effect after 24 hours", {
        reasonCodes: ["PASSKEY_REQUIRED", "LOOSEN_PENDING"],
        details: { challengeId, webauthnOptions: await assertionOptions(db, userId, hash) },
      });
    }
    const gated = takeGated(body.challengeId, userId, "settings");
    if (!gated || jcs(gated.payload) !== jcs(loosenCore)) {
      throw new HttpProblem(409, "CHALLENGE_MISMATCH", "The signed change differs from this request; start again");
    }
    const check = await verifyRulesAssertion(db, { userId, assertion: body.assertion, expectedChallenge: gated.hash, challengeReason: "ASSERTION_INVALID" });
    if (!check.ok) throw new HttpProblem(403, "PASSKEY_REQUIRED", check.detail, { reasonCodes: ["PASSKEY_REQUIRED", check.reason] });
    assertion = body.assertion;
    changeHash = gated.hash;
  }

  const now = clock.now();
  const settings = await db.transaction(async (tx) => {
    let s = current;
    if (!isEmpty(tighten)) {
      s = await applyChangeSet(tx, userId, current, caps, tighten);
      const row = await tx
        .insert(ruleChanges)
        .values({
          userId,
          kind: "SETTINGS",
          before: beforeOf(current, caps, tighten),
          after: tighten,
          direction: "TIGHTEN",
          changeHash: jcsHash({ v: 1, kind: "SETTINGS", userId, before: beforeOf(current, caps, tighten), after: tighten }),
          effectiveAt: now,
          appliedAt: now,
          createdAt: now,
        })
        .returning({ id: ruleChanges.id });
      await ledger.append("RULES_TIGHTENED", { userId, ruleChangeId: row[0]!.id, after: tighten }, tx);
    }
    if (loosenCore) {
      const effectiveAt = addMs(now, LOOSEN_DELAY_MS);
      const row = await tx
        .insert(ruleChanges)
        .values({
          userId,
          kind: "SETTINGS",
          before: loosenCore.before,
          after: loosenCore.after,
          direction: "LOOSEN",
          assertion: assertion as never,
          changeHash,
          effectiveAt,
          createdAt: now,
        })
        .returning({ id: ruleChanges.id });
      ruleChange = { id: row[0]!.id, effectiveAt };
      await ledger.append("RULES_LOOSEN_PENDING", { userId, ruleChangeId: row[0]!.id, changeHash, effectiveAt: effectiveAt.toISOString(), after: loosen }, tx);
    }
    return s;
  });
  const rc = ruleChange as { id: string; effectiveAt: Date } | null;
  return {
    settings,
    pending: rc ? [{ ruleChangeId: rc.id, kind: "SETTINGS", direction: "LOOSEN", effectiveAt: rc.effectiveAt.toISOString() }] : [],
  };
}

/** Scheduler (spec §15): apply signed loosenings whose effectiveAt has passed. */
export async function applyDueRuleChanges(): Promise<number> {
  const db = getDb();
  const now = clock.now();
  const due = await db
    .select()
    .from(ruleChanges)
    .where(
      and(
        eq(ruleChanges.kind, "SETTINGS"),
        eq(ruleChanges.direction, "LOOSEN"),
        isNull(ruleChanges.appliedAt),
        isNull(ruleChanges.canceledAt),
        lte(ruleChanges.effectiveAt, now),
      ),
    );
  let applied = 0;
  for (const rc of due) {
    if (!rc.assertion) continue; // never apply an unsigned loosening (I8)
    const { user, profile, caps } = await loadUser(db, rc.userId);
    const current = settingsOf(user, profile.notificationMode);
    try {
      await db.transaction(async (tx) => {
        await applyChangeSet(tx, rc.userId, current, caps, rc.after as ChangeSet);
        await tx.update(ruleChanges).set({ appliedAt: now }).where(eq(ruleChanges.id, rc.id));
        await ledger.append("RULES_LOOSENED", { userId: rc.userId, ruleChangeId: rc.id, after: rc.after }, tx);
      });
      applied++;
    } catch (err) {
      await db.update(ruleChanges).set({ canceledAt: now }).where(eq(ruleChanges.id, rc.id));
      await ledger.append("RULES_LOOSEN_CANCELED", { userId: rc.userId, ruleChangeId: rc.id, reason: (err as Error).message });
    }
  }
  return applied;
}
