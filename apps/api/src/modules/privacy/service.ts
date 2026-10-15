/*
 * Data-subject rights (GDPR Chapter III) and storage limitation (Art. 5(1)(e)).
 *
 * - exportUserData: Art. 15 (access) + Art. 20 (portability): every row about the user, decrypted (payee
 *   accounts, sealed ledger fields), plus the Art. 15(1) processing information.
 * - eraseUser: Art. 17 by deletion + crypto-shredding. What is erased vs retained is listed in ERASED/RETAINED
 *   (and docs/PRIVACY.md). Payment records are retained under Art. 17(3)(b) (legal record-keeping, e.g.
 *   AMLD (EU) 2015/849 Art. 40: 5 years) — reduced to amounts, dates, statuses, hashes and signatures; the
 *   counterparty names, accounts and purpose texts in them are overwritten. The ledger keeps every entry (the
 *   hash chain still verifies); its personal fields are ciphertext under the shredded key.
 * - restrictUser: Art. 18 — freeze (no payments) + no AI processing; lifted only by POST /unfreeze (I8).
 * - purgeExpired: retention job (RETENTION_DAYS_*), run by the scheduler on the demo clock.
 */
import { and, eq, inArray, isNull, lt, ne, notInArray, sql } from "drizzle-orm";

import { getDb, type DbOrTx } from "../../db/client.ts";
import {
  approvals,
  budgets,
  cardFeeProfiles,
  cards,
  devices,
  issuedCards,
  ledgerEntries,
  fundingSources,
  mandates,
  notifications,
  obligations,
  payees,
  payments,
  placeholderMaps,
  profiles,
  proposals,
  ruleChanges,
  transactions,
  userKeys,
  users,
  recoveryCodes,
  webauthnCredentialsPayments,
  webauthnCredentialsRules,
} from "../../db/schema.ts";
import { agentDocuments, agentMessages, conversations, merchantCategoryMemory, onboardingDrafts } from "../../db/schema.intel.ts";
import { env } from "../../env.ts";
import { audit } from "../../http/audit.ts";
import { HttpProblem } from "../../http/problem.ts";
import { addMs, clock, DAY_MS, HOUR_MS } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { decryptAccount } from "../payees/crypto.ts";
import { cancelPendingUnfreezes } from "../users/unfreeze.ts";
import { clearDekCache, sealPii, shredUserKey, viewLedgerPayload } from "./keys.ts";
import { aiNotice } from "./notice.ts";

export const ERASED_MARK = "[erased]";

/** Erasure result categories (EraseResponse). */
export const ERASED = [
  "profile (name, incomes, reserve rules) and AI consent",
  "passkeys (both credential stores), devices and push tokens",
  "payees (names, encrypted accounts), obligations, budgets, cards and card fee profiles, linked accounts",
  "captured transactions and merchant category memory",
  "notifications, agent conversations, placeholder maps, uploaded documents, onboarding drafts",
  "unexecuted proposals",
  "personal fields in the ledger (sealed with your data key, which is destroyed)",
];
export const RETAINED = [
  {
    category: "payment records: amount, currency, rail, status, dates, order hash, approval signature",
    basis: "GDPR Art. 17(3)(b): legal record-keeping for payment services (e.g. AMLD Art. 40, 5 years); names, accounts and purposes are overwritten",
  },
  {
    category: "signed mandates and rule changes (no names), revoked",
    basis: "GDPR Art. 17(3)(e): evidence that each automatic payment was authorised",
  },
  {
    category: "ledger entries (hash chain) with personal fields as unreadable ciphertext",
    basis: "integrity of the append-only audit ledger (I12); crypto-shredding makes the personal fields inaccessible",
  },
];

/** Payment `details` keys that carry no personal data and stay after erasure (allowlist). */
const PAYMENT_DETAIL_KEYS_KEPT = new Set(["provider", "intentId", "cardId", "last4", "expiresAt", "simulated", "quoteId", "recipientId", "check"]);

async function conversationIds(db: DbOrTx, userId: string): Promise<string[]> {
  const a = await db.selectDistinct({ id: agentMessages.conversationId }).from(agentMessages).where(eq(agentMessages.userId, userId));
  const b = await db.select({ id: onboardingDrafts.conversationId }).from(onboardingDrafts).where(eq(onboardingDrafts.userId, userId));
  const c = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.userId, userId));
  return [...new Set([...a, ...b, ...c].map((r) => r.id))];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function processingInfo() {
  const e = env();
  const notice = aiNotice();
  return {
    controller: "Kassa (competition prototype; no real money moves)",
    purposes: [
      { purpose: "personal finance assistant: budgets, bills, payment proposals", basis: "GDPR Art. 6(1)(b) contract" },
      { purpose: "AI chat and document reading", basis: "GDPR Art. 6(1)(a) consent (withdrawable: POST /privacy/ai-consent)" },
      { purpose: "region CN: AI processing outside mainland China (cross-border transfer)", basis: "PIPL Art. 38–39 separate consent (withdrawable: POST /privacy/pipl-consent)" },
      { purpose: "fraud prevention, sanctions screening, audit ledger", basis: "GDPR Art. 6(1)(c) legal obligation / 6(1)(f) legitimate interest" },
    ],
    recipients: [
      { recipient: `planner model: ${notice.planner.provider}`, receives: notice.plannerReceives, local: notice.planner.local },
      { recipient: `reader model: ${notice.reader.provider}`, receives: notice.readerReceives, local: notice.reader.local },
      { recipient: "payment rails (simulated: mock bank, Stripe test mode)", receives: ["payee name and account, amount, reference for an approved payment"] },
    ],
    retentionDays: {
      notifications: e.RETENTION_DAYS_NOTIFICATIONS,
      conversationsAndPlaceholderMaps: e.RETENTION_DAYS_PLACEHOLDER_MAPS,
      uploadedDocuments: e.RETENTION_DAYS_DOCUMENTS,
      capturedRawText: e.RETENTION_DAYS_CAPTURED_TEXT,
      paymentRecords: "kept after erasure in reduced form (GDPR Art. 17(3)(b))",
    },
    source: "provided by you, captured from your bank notifications/shortcuts, and payment rail status updates",
    automatedDecisions: {
      exists: true,
      logic: "fixed rules decide AUTO / ASK / HANDOFF / REFUSE for each proposed payment (caps, payee verification, sanctions screening, risk score); the AI cannot approve",
      safeguard: "GDPR Art. 22(3): every refusal has reason codes; you can reject, change your rules, or contact us",
    },
    rights: ["access/portability: GET /privacy/export", "rectification: PATCH /me", "erasure: POST /privacy/erase", "restriction: POST /privacy/restrict", "withdraw AI consent: POST /privacy/ai-consent {consent:false}", "withdraw the PIPL cross-border consent (region CN): POST /privacy/pipl-consent {consent:false}"],
  };
}

/** Art. 15 + Art. 20 export: all personal data, decrypted, machine-readable. */
export async function exportUserData(userId: string) {
  const db = getDb();
  const u = (await db.select().from(users).where(eq(users.id, userId)))[0];
  if (!u) throw new HttpProblem(404, "NOT_FOUND", "user not found");
  const convIds = await conversationIds(db, userId);
  const own = <T extends { userId: unknown }>(t: T) => eq(t.userId as never, userId);

  const payeeRows = await db.select().from(payees).where(own(payees));
  const cardRows = await db.select().from(cards).where(own(cards));
  const proposalRows = await db.select().from(proposals).where(own(proposals));
  const proposalIds = proposalRows.map((p) => p.id);
  const ledgerRows = await db.select().from(ledgerEntries).where(sql`${ledgerEntries.payload}->>'userId' = ${userId}`).orderBy(ledgerEntries.seq);

  const data = {
    user: { id: u.id, displayName: u.displayName, homeCurrency: u.homeCurrency, region: u.region, preset: u.preset, moneyMode: u.moneyMode, overrides: u.overrides, frozenAt: u.frozenAt, createdAt: u.createdAt, aiConsentAt: u.aiConsentAt, piplConsentAt: u.piplConsentAt, restrictedAt: u.restrictedAt, erasedAt: u.erasedAt },
    profile: (await db.select().from(profiles).where(eq(profiles.userId, userId)))[0] ?? null,
    passkeys: (await db.select({ credentialId: webauthnCredentialsRules.credentialId, transports: webauthnCredentialsRules.transports, createdAt: webauthnCredentialsRules.createdAt }).from(webauthnCredentialsRules).where(own(webauthnCredentialsRules))),
    devices: await db.select({ id: devices.id, kind: devices.kind, platform: devices.platform, createdAt: devices.createdAt, revokedAt: devices.revokedAt }).from(devices).where(own(devices)),
    payees: payeeRows.map(({ accountEnc, ...p }) => {
      let account: string | null = null;
      try {
        account = accountEnc === null ? null : decryptAccount(userId, accountEnc, p.id);
      } catch {
        account = null;
      }
      return { ...p, account };
    }),
    obligations: await db.select().from(obligations).where(own(obligations)),
    linkedAccounts: (await db.select().from(fundingSources).where(own(fundingSources))).map(({ linkHash: _h, codeHash: _c, ...f }) => f),
    budgets: await db.select().from(budgets).where(own(budgets)),
    cards: cardRows,
    cardFeeProfiles: cardRows.length ? await db.select().from(cardFeeProfiles).where(inArray(cardFeeProfiles.cardId, cardRows.map((c) => c.id))) : [],
    transactions: await db.select().from(transactions).where(own(transactions)),
    merchantCategoryMemory: await db.select().from(merchantCategoryMemory).where(own(merchantCategoryMemory)),
    mandates: await db.select().from(mandates).where(own(mandates)),
    ruleChanges: await db.select().from(ruleChanges).where(own(ruleChanges)),
    proposals: proposalRows,
    approvals: proposalIds.length ? await db.select().from(approvals).where(inArray(approvals.proposalId, proposalIds)) : [],
    payments: await db.select().from(payments).where(own(payments)),
    issuedCards: await db.select().from(issuedCards).where(eq(issuedCards.userId, userId)),
    notifications: await db.select().from(notifications).where(own(notifications)),
    conversations: {
      messages: convIds.length ? await db.select().from(agentMessages).where(inArray(agentMessages.conversationId, convIds)) : [],
      placeholderMaps: convIds.length ? await db.select().from(placeholderMaps).where(inArray(placeholderMaps.conversationId, convIds)) : [],
      onboardingDrafts: await db.select().from(onboardingDrafts).where(own(onboardingDrafts)),
      owned: await db.select().from(conversations).where(own(conversations)),
    },
    documents: await db.select().from(agentDocuments).where(own(agentDocuments)),
    ledger: await Promise.all(ledgerRows.map(async (e) => ({ seq: e.seq, ts: e.ts, type: e.type, payload: await viewLedgerPayload(e.payload, db), hash: e.hash }))),
  };
  await audit("PRIVACY_EXPORTED", { userId });
  return {
    format: "kassa.dsar-export" as const,
    version: 1 as const,
    generatedAt: clock.now().toISOString(),
    subject: { userId },
    processing: processingInfo(),
    // JSON round trip: Dates → RFC 3339 strings, exactly what the client receives.
    data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>,
  };
}

/** Art. 18 restriction: freeze + stop AI processing. Idempotent. */
export async function restrictUser(userId: string): Promise<{ restrictedAt: Date; frozenAt: Date }> {
  const db = getDb();
  const now = clock.now();
  return db.transaction(async (tx) => {
    const u = (await tx.select().from(users).where(eq(users.id, userId)))[0];
    if (!u) throw new HttpProblem(404, "NOT_FOUND", "user not found");
    const restrictedAt = u.restrictedAt ?? now;
    const frozenAt = u.frozenAt ?? now;
    await tx.update(users).set({ restrictedAt, frozenAt }).where(eq(users.id, userId));
    if (!u.frozenAt) await ledger.append("ACCOUNT_FROZEN", { userId, reason: "GDPR Art. 18 restriction" }, tx);
    // A restriction is a tightening: pending unfreezes are cancelled (I8).
    await cancelPendingUnfreezes(tx, userId);
    if (!u.restrictedAt) await audit("PRIVACY_RESTRICTED", { userId }, tx);
    return { restrictedAt, frozenAt };
  });
}

/** Give or withdraw consent to AI processing (Art. 7(3): withdrawal as easy as giving). */
export async function setAiConsent(userId: string, consent: boolean, db: DbOrTx = getDb()): Promise<Date | null> {
  const now = clock.now();
  const u = (await db.select({ aiConsentAt: users.aiConsentAt }).from(users).where(eq(users.id, userId)))[0];
  if (!u) throw new HttpProblem(404, "NOT_FOUND", "user not found");
  if (consent && u.aiConsentAt) return u.aiConsentAt;
  if (!consent && !u.aiConsentAt) return null;
  const value = consent ? now : null;
  await db.update(users).set({ aiConsentAt: value }).where(eq(users.id, userId));
  await audit(consent ? "AI_CONSENT_GIVEN" : "AI_CONSENT_WITHDRAWN", { userId, noticeVersion: aiNotice().noticeVersion }, db);
  return value;
}

/** Give or withdraw the separate PIPL cross-border consent for AI processing (Art. 39; withdrawable like Art. 15 PIPL). */
export async function setPiplConsent(userId: string, consent: boolean, db: DbOrTx = getDb()): Promise<Date | null> {
  const now = clock.now();
  const u = (await db.select({ piplConsentAt: users.piplConsentAt, region: users.region }).from(users).where(eq(users.id, userId)))[0];
  if (!u) throw new HttpProblem(404, "NOT_FOUND", "user not found");
  if (consent && u.piplConsentAt) return u.piplConsentAt;
  if (!consent && !u.piplConsentAt) return null;
  const value = consent ? now : null;
  await db.update(users).set({ piplConsentAt: value }).where(eq(users.id, userId));
  await audit(consent ? "PIPL_CONSENT_GIVEN" : "PIPL_CONSENT_WITHDRAWN", { userId, noticeVersion: aiNotice(u.region).noticeVersion }, db);
  return value;
}

/** Art. 16 rectification of the display name (the old value is not kept). */
export async function rectifyDisplayName(userId: string, displayName: string): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.update(users).set({ displayName }).where(eq(users.id, userId));
    await audit("PROFILE_RECTIFIED", { userId, fields: ["displayName"], ...(await sealPii(userId, { displayName }, tx)) }, tx);
  });
}

/**
 * Art. 17 erasure. One transaction: everything personal is deleted or overwritten and the data key is
 * shredded; the user row stays as a tombstone (payment records reference it) with erasedAt set, so every
 * session token for it is refused (auth/session.ts).
 */
export async function eraseUser(userId: string): Promise<{ erasedAt: Date }> {
  const db = getDb();
  const now = clock.now();
  const u = (await db.select().from(users).where(eq(users.id, userId)))[0];
  if (!u) throw new HttpProblem(404, "NOT_FOUND", "user not found");
  if (u.erasedAt) return { erasedAt: u.erasedAt };
  const convIds = await conversationIds(db, userId);

  await db.transaction(async (tx) => {
    // Shred first: any entry appended for this user from here on can no longer seal personal fields.
    await shredUserKey(userId, tx);

    if (convIds.length) {
      await tx.delete(agentMessages).where(inArray(agentMessages.conversationId, convIds));
      await tx.delete(placeholderMaps).where(inArray(placeholderMaps.conversationId, convIds));
    }
    await tx.delete(agentMessages).where(eq(agentMessages.userId, userId));
    await tx.delete(onboardingDrafts).where(eq(onboardingDrafts.userId, userId));
    await tx.delete(conversations).where(eq(conversations.userId, userId));
    await tx.delete(agentDocuments).where(eq(agentDocuments.userId, userId));
    await tx.delete(merchantCategoryMemory).where(eq(merchantCategoryMemory.userId, userId));
    await tx.delete(notifications).where(eq(notifications.userId, userId));
    await tx.delete(devices).where(eq(devices.userId, userId));
    await tx.delete(webauthnCredentialsRules).where(eq(webauthnCredentialsRules.userId, userId));
    await tx.delete(webauthnCredentialsPayments).where(eq(webauthnCredentialsPayments.userId, userId));
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    await tx.delete(transactions).where(eq(transactions.userId, userId));
    await tx.delete(budgets).where(eq(budgets.userId, userId));
    await tx.delete(obligations).where(eq(obligations.userId, userId));
    await tx.delete(cards).where(eq(cards.userId, userId)); // card_fee_profiles cascade
    await tx.delete(payees).where(eq(payees.userId, userId));
    await tx.delete(fundingSources).where(eq(fundingSources.userId, userId));

    // Proposals that never got an approval are drafts, not payment records.
    const approved = tx.select({ id: approvals.proposalId }).from(approvals);
    await tx.delete(proposals).where(and(eq(proposals.userId, userId), notInArray(proposals.id, approved)));
    for (const p of await tx.select().from(proposals).where(eq(proposals.userId, userId))) {
      const { purpose: _p, items: _i, ...draft } = p.draft;
      await tx
        .update(proposals)
        .set({
          draft: { ...draft, purpose: ERASED_MARK },
          // Keeps orderHash and amounts: the approval signature covers orderHash, which still commits to the
          // original order, while the payee name, account hash and purpose are overwritten.
          canonicalOrder: p.canonicalOrder ? { ...p.canonicalOrder, payeeName: ERASED_MARK, payeeAccountHash: ERASED_MARK, purpose: ERASED_MARK } : null,
          status: p.status === "PENDING_APPROVAL" ? "EXPIRED" : p.status,
          updatedAt: now,
        })
        .where(eq(proposals.id, p.id));
    }
    for (const pay of await tx.select({ id: payments.id, details: payments.details }).from(payments).where(eq(payments.userId, userId))) {
      const kept = Object.fromEntries(Object.entries(pay.details ?? {}).filter(([k]) => PAYMENT_DETAIL_KEYS_KEPT.has(k)));
      await tx.update(payments).set({ details: kept }).where(eq(payments.id, pay.id));
    }
    await tx.update(issuedCards).set({ expectedMerchantNorm: ERASED_MARK }).where(eq(issuedCards.userId, userId));
    await tx
      .update(mandates)
      .set({ status: "REVOKED", revokedAt: sql`coalesce(${mandates.revokedAt}, ${now.toISOString()}::timestamptz)` })
      .where(and(eq(mandates.userId, userId), ne(mandates.status, "REVOKED")));
    await tx
      .update(ruleChanges)
      .set({ canceledAt: now })
      .where(and(eq(ruleChanges.userId, userId), isNull(ruleChanges.appliedAt), isNull(ruleChanges.canceledAt)));
    await tx
      .update(profiles)
      .set({ incomes: [], reserveRules: {}, bankProfileId: null, stripeCardholderId: null })
      .where(eq(profiles.userId, userId));
    await tx
      .update(users)
      .set({ displayName: ERASED_MARK, erasedAt: now, frozenAt: u.frozenAt ?? now, restrictedAt: u.restrictedAt ?? now, aiConsentAt: null, piplConsentAt: null })
      .where(eq(users.id, userId));
    await audit("PRIVACY_ERASED", { userId, erased: ERASED.length, retained: RETAINED.map((r) => r.category) }, tx);
  });
  clearDekCache(userId);
  return { erasedAt: now };
}

/** True when the user's data key has been shredded. */
export async function isShredded(userId: string): Promise<boolean> {
  const r = (await getDb().select({ w: userKeys.wrappedDek, s: userKeys.shreddedAt }).from(userKeys).where(eq(userKeys.userId, userId)))[0];
  return Boolean(r && r.s && !r.w);
}

// ---------- retention (GDPR Art. 5(1)(e)) ----------

export type PurgeCounts = { notifications: number; conversations: number; placeholderMaps: number; documents: number; capturedTexts: number };

const cutoff = (now: Date, days: number) => (days > 0 ? addMs(now, -days * DAY_MS) : null);

/** Delete or minimise data past its retention period. Returns what was purged. */
export async function purgeExpired(now: Date = clock.now()): Promise<PurgeCounts> {
  const db = getDb();
  const e = env();
  const counts: PurgeCounts = { notifications: 0, conversations: 0, placeholderMaps: 0, documents: 0, capturedTexts: 0 };

  const nCut = cutoff(now, e.RETENTION_DAYS_NOTIFICATIONS);
  if (nCut) counts.notifications = (await db.delete(notifications).where(lt(notifications.createdAt, nCut)).returning({ id: notifications.id })).length;

  const cCut = cutoff(now, e.RETENTION_DAYS_PLACEHOLDER_MAPS);
  if (cCut) {
    // A conversation expires as a whole (history references its placeholders) once its last message is old.
    const stale = await db
      .select({ id: agentMessages.conversationId })
      .from(agentMessages)
      .groupBy(agentMessages.conversationId)
      // ISO string: a raw sql operand has no column encoder, and postgres.js rejects a bare Date.
      .having(lt(sql`max(${agentMessages.createdAt})`, cCut.toISOString()));
    const ids = stale.map((r) => r.id);
    if (ids.length) {
      await db.delete(agentMessages).where(inArray(agentMessages.conversationId, ids));
      const uuids = ids.filter((id) => UUID_RE.test(id));
      if (uuids.length) await db.delete(conversations).where(and(inArray(conversations.id, uuids), eq(conversations.channel, "agent")));
      counts.conversations = ids.length;
    }
    const active = db.selectDistinct({ id: agentMessages.conversationId }).from(agentMessages);
    counts.placeholderMaps = (
      await db
        .delete(placeholderMaps)
        .where(and(lt(placeholderMaps.createdAt, cCut), notInArray(placeholderMaps.conversationId, active)))
        .returning({ id: placeholderMaps.conversationId })
    ).length;
  }

  const dCut = cutoff(now, e.RETENTION_DAYS_DOCUMENTS);
  if (dCut) counts.documents = (await db.delete(agentDocuments).where(lt(agentDocuments.createdAt, dCut)).returning({ id: agentDocuments.id })).length;

  const tCut = cutoff(now, e.RETENTION_DAYS_CAPTURED_TEXT);
  if (tCut) {
    // Minimise rather than delete: budgets need the normalised merchant, not the raw notification text.
    counts.capturedTexts = (
      await db
        .update(transactions)
        .set({ merchantRaw: transactions.merchantNorm })
        .where(and(lt(transactions.createdAt, tCut), ne(transactions.merchantRaw, transactions.merchantNorm)))
        .returning({ id: transactions.id })
    ).length;
    // The same for where a tap happened: the street and the (rounded) coordinates go; the city and the place's name stay.
    await db
      .update(transactions)
      .set({ place: sql`${transactions.place} - 'street' - 'lat' - 'lon'` })
      .where(and(lt(transactions.createdAt, tCut), sql`${transactions.place} ?| array['street', 'lat', 'lon']`));
  }

  if (Object.values(counts).some((n) => n > 0)) await audit("RETENTION_PURGED", { ...counts, at: now.toISOString() });
  return counts;
}

let lastPurgeMs = -Infinity;

/** Scheduler job: at most once per demo-clock hour. */
export async function purgeIfDue(): Promise<PurgeCounts | null> {
  const now = clock.now();
  if (now.getTime() - lastPurgeMs < HOUR_MS) return null;
  lastPurgeMs = now.getTime();
  return purgeExpired(now);
}

/** Tests: run the next purgeIfDue immediately. */
export function resetPurgeScheduleForTests(): void {
  lastPurgeMs = -Infinity;
}
