/*
 * Mandates (spec §6, §7 T1, I8). Creating a mandate widens what Kassa may pay without asking, so it is a
 * loosening: it needs a passkey assertion over mandateHash(core) and becomes effective 24 h later
 * (status PENDING_EFFECTIVE → ACTIVE by the scheduler). Revoking is a tightening: instant.
 */
import { mandateHash, normalizeMandateCore, type MandateCore, type MandateDto, type MandateOptionsRequest } from "@kassa/shared";
import { and, eq, inArray, lte } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { getDb } from "../../db/client.ts";
import { mandates, payees, ruleChanges } from "../../db/schema.ts";
import { auditAssertionFailure, ownedNotFound } from "../../http/audit.ts";
import { conflict, HttpProblem, notFound } from "../../http/problem.ts";
import { addMs, clock, DAY_MS } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { assertionOptions, verifyRulesAssertion } from "../rules/webauthn.ts";
import { mandatePeriodUsage } from "./scope.ts";

export const LOOSEN_DELAY_MS = DAY_MS;

export async function toMandateDto(m: typeof mandates.$inferSelect): Promise<MandateDto> {
  return {
    id: m.id,
    payeeIds: m.payeeIds,
    categories: m.categories,
    currency: m.currency,
    maxPerPaymentMinor: m.maxPerPaymentMinor,
    maxPerPeriodMinor: m.maxPerPeriodMinor,
    period: m.period,
    validFrom: m.validFrom.toISOString(),
    validUntil: m.validUntil?.toISOString() ?? null,
    mandateHash: m.mandateHash,
    status: m.status,
    effectiveAt: m.effectiveAt.toISOString(),
    usedThisPeriodMinor: await mandatePeriodUsage(getDb(), m.id, m.period, clock.now()),
  };
}

export async function listMandates(userId: string) {
  return getDb().select().from(mandates).where(eq(mandates.userId, userId));
}

/** Build the exact core the user will sign; challenge = mandateHash(core). */
export async function mandateOptions(userId: string, req: MandateOptionsRequest) {
  const db = getDb();
  const owned = await db
    .select({ id: payees.id })
    .from(payees)
    .where(and(eq(payees.userId, userId), inArray(payees.id, req.payeeIds)));
  if (owned.length !== new Set(req.payeeIds).size) throw notFound("payee");
  let core: MandateCore;
  try {
    core = normalizeMandateCore({
      v: 1,
      mandateId: randomUUID(),
      userId,
      payeeIds: req.payeeIds,
      categories: req.categories,
      currency: req.currency,
      maxPerPaymentMinor: req.maxPerPaymentMinor,
      maxPerPeriodMinor: req.maxPerPeriodMinor,
      period: req.period,
      validFrom: clock.now().toISOString(),
      validUntil: req.validUntil,
    });
  } catch (err) {
    throw new HttpProblem(422, "INVALID_MANDATE", (err as Error).message);
  }
  const hash = mandateHash(core);
  return { core, mandateHash: hash, webauthnOptions: await assertionOptions(db, userId, hash) };
}

export async function createMandate(userId: string, core: MandateCore, assertion: unknown) {
  const db = getDb();
  if (core.userId !== userId) throw new HttpProblem(403, "FORBIDDEN", "mandate core is for another user");
  let hash: string;
  try {
    hash = mandateHash(core);
  } catch (err) {
    throw new HttpProblem(422, "INVALID_MANDATE", (err as Error).message);
  }
  const owned = await db
    .select({ id: payees.id })
    .from(payees)
    .where(and(eq(payees.userId, userId), inArray(payees.id, core.payeeIds)));
  if (owned.length !== core.payeeIds.length) throw notFound("payee");
  if ((await db.select({ id: mandates.id }).from(mandates).where(eq(mandates.id, core.mandateId))).length > 0) {
    throw conflict("MANDATE_EXISTS", "mandate id already used");
  }
  const check = await verifyRulesAssertion(db, { userId, assertion, expectedChallenge: hash, challengeReason: "ASSERTION_INVALID" });
  if (!check.ok) {
    await auditAssertionFailure(userId, "mandate", check.reason);
    throw new HttpProblem(403, "PASSKEY_REQUIRED", check.detail, { reasonCodes: ["PASSKEY_REQUIRED", check.reason] });
  }
  const now = clock.now();
  const effectiveAt = addMs(now, LOOSEN_DELAY_MS);
  const row = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(mandates)
      .values({
        id: core.mandateId,
        userId,
        payeeIds: core.payeeIds,
        categories: core.categories,
        currency: core.currency,
        maxPerPaymentMinor: core.maxPerPaymentMinor,
        maxPerPeriodMinor: core.maxPerPeriodMinor,
        period: core.period,
        validFrom: new Date(core.validFrom),
        validUntil: core.validUntil ? new Date(core.validUntil) : null,
        mandateHash: hash,
        userAssertion: assertion as never,
        status: "PENDING_EFFECTIVE",
        effectiveAt,
        createdAt: now,
      })
      .returning();
    await tx.insert(ruleChanges).values({
      userId,
      kind: "MANDATE_CREATE",
      before: {},
      after: { mandateId: core.mandateId, mandateHash: hash },
      direction: "LOOSEN",
      assertion: assertion as never,
      changeHash: hash,
      effectiveAt,
      createdAt: now,
    });
    await ledger.append("MANDATE_CREATED", { userId, mandateId: core.mandateId, mandateHash: hash, effectiveAt: effectiveAt.toISOString() }, tx);
    return inserted[0]!;
  });
  return row;
}

export async function revokeMandate(userId: string, mandateId: string) {
  const db = getDb();
  const m = (await db.select().from(mandates).where(and(eq(mandates.id, mandateId), eq(mandates.userId, userId))))[0];
  if (!m) throw await ownedNotFound(userId, "mandate", mandateId, async () => (await db.select({ id: mandates.id }).from(mandates).where(eq(mandates.id, mandateId))).length > 0);
  if (m.status === "REVOKED") return m;
  const now = clock.now();
  return db.transaction(async (tx) => {
    const r = await tx.update(mandates).set({ status: "REVOKED", revokedAt: now }).where(eq(mandates.id, mandateId)).returning();
    await tx.insert(ruleChanges).values({
      userId,
      kind: "MANDATE_REVOKE",
      before: { mandateId, status: m.status },
      after: { mandateId, status: "REVOKED" },
      direction: "TIGHTEN",
      changeHash: m.mandateHash,
      effectiveAt: now,
      appliedAt: now,
      createdAt: now,
    });
    // A pending creation is superseded.
    await ledger.append("MANDATE_REVOKED", { userId, mandateId }, tx);
    return r[0]!;
  });
}

/** Scheduler: PENDING_EFFECTIVE mandates whose effectiveAt passed become ACTIVE. */
export async function activateDueMandates(): Promise<number> {
  const db = getDb();
  const now = clock.now();
  const due = await db
    .select()
    .from(mandates)
    .where(and(eq(mandates.status, "PENDING_EFFECTIVE"), lte(mandates.effectiveAt, now)));
  for (const m of due) {
    await db.transaction(async (tx) => {
      await tx.update(mandates).set({ status: "ACTIVE" }).where(and(eq(mandates.id, m.id), eq(mandates.status, "PENDING_EFFECTIVE")));
      await tx
        .update(ruleChanges)
        .set({ appliedAt: now })
        .where(and(eq(ruleChanges.kind, "MANDATE_CREATE"), eq(ruleChanges.changeHash, m.mandateHash)));
      await ledger.append("MANDATE_ACTIVE", { userId: m.userId, mandateId: m.id }, tx);
    });
  }
  return due.length;
}
