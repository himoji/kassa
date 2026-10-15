/*
 * Linking a card or bank account (shared/fundingSource.ts). Two steps:
 *   1 start: a PENDING row (card: the chosen Stripe test card; bank: the bank, the last 4 of the account and a
 *     one-tenge code "sent" with the bank's note, simulated);
 *   2 confirm: the passkey over linkHash (HTTP 428 PASSKEY_REQUIRED round trip, like verify-callback) and, for a bank,
 *     the code. A card is then saved at Stripe (SetupIntent, off-session use) when Stripe test keys are set.
 * Only an ACTIVE source can be signed into an order or pulled from. Removing one never touches past payments.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";

import { fundingSourceLinkHash, last4Of, TEST_CARDS, type FundingSourceLinkCore, type LinkBankRequest, type LinkCardRequest, type StartLinkResponse } from "@kassa/shared";
import { and, eq, isNotNull } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { fundingSources, users } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { auditAssertionFailure } from "../../http/audit.ts";
import { conflict, HttpProblem, notFound } from "../../http/problem.ts";
import { putGated, takeGated } from "../auth/challenges.ts";
import { sealPii } from "../privacy/keys.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { bankMode } from "../rails/bankApi.ts";
import { stripe } from "../rails/issuing.ts";
import { assertionOptions, verifyRulesAssertion } from "../rules/webauthn.ts";
import { labelOf, toFundingSourceDto, type FundingSourceRow } from "./store.ts";

const MAX_CODE_ATTEMPTS = 5;
const MAX_SOURCES = 10;

const sha = (s: string) => createHash("sha256").update(s).digest("base64url");

async function ownSource(userId: string, id: string): Promise<FundingSourceRow> {
  const row = (await getDb().select().from(fundingSources).where(and(eq(fundingSources.id, id), eq(fundingSources.userId, userId))))[0];
  if (!row || row.status === "REMOVED") throw notFound("Linked account");
  return row;
}

async function insertPending(userId: string, v: { kind: "CARD" | "BANK"; provider: "STRIPE" | "MOCK_BANK"; institution: string; last4: string; country: string; currency: string; simulated: boolean; providerRef: string | null; codeHash: string | null }): Promise<FundingSourceRow> {
  const db = getDb();
  const count = (await db.select({ id: fundingSources.id }).from(fundingSources).where(and(eq(fundingSources.userId, userId), eq(fundingSources.status, "ACTIVE")))).length;
  if (count >= MAX_SOURCES) throw conflict("TOO_MANY_SOURCES", `You can link up to ${MAX_SOURCES} accounts`);
  const id = crypto.randomUUID();
  const core: FundingSourceLinkCore = {
    v: 1,
    purpose: "kassa:link-funding-source",
    sourceId: id,
    userId,
    kind: v.kind,
    provider: v.provider,
    label: labelOf(v),
    currency: v.currency,
    nonce: randomBytes(16).toString("base64url"),
  };
  const row = (
    await db
      .insert(fundingSources)
      .values({ id, userId, ...v, status: "PENDING", linkHash: fundingSourceLinkHash(core), createdAt: clock.now() })
      .returning()
  )[0]!;
  await ledger.append("FUNDING_SOURCE_LINK_STARTED", { userId, sourceId: id, kind: v.kind, provider: v.provider, currency: v.currency, linkHash: row.linkHash, ...(await sealPii(userId, { name: labelOf(v) })) });
  return row;
}

async function startResponse(userId: string, row: FundingSourceRow, simulatedCode?: string): Promise<StartLinkResponse> {
  return {
    source: toFundingSourceDto(row),
    linkHash: row.linkHash,
    webauthnOptions: await assertionOptions(getDb(), userId, row.linkHash),
    verification: { kind: row.kind === "BANK" ? "MICRO_DEPOSIT" : "PASSKEY", ...(simulatedCode ? { simulatedCode } : {}) },
  };
}

export async function startCardLink(userId: string, req: LinkCardRequest): Promise<StartLinkResponse> {
  const card = TEST_CARDS[req.testCard];
  const u = (await getDb().select({ region: users.region }).from(users).where(eq(users.id, userId)))[0];
  const row = await insertPending(userId, {
    kind: "CARD",
    provider: "STRIPE",
    institution: card.brand,
    last4: card.last4,
    country: u?.region === "CN" ? "CN" : "US",
    currency: req.currency,
    simulated: !env().stripeEnabled,
    // The test PaymentMethod to save; replaced by the saved pm_… once Stripe confirms the SetupIntent.
    providerRef: card.paymentMethod,
    codeHash: null,
  });
  return startResponse(userId, row);
}

export async function startBankLink(userId: string, req: LinkBankRequest): Promise<StartLinkResponse> {
  const code = String(randomInt(1000, 10_000));
  const row = await insertPending(userId, {
    kind: "BANK",
    provider: "MOCK_BANK",
    institution: req.bankName,
    last4: last4Of(req.account),
    country: req.country,
    currency: req.currency,
    simulated: true,
    providerRef: `mockbank:${sha(`${userId}:${req.account.replace(/\s+/g, "").toUpperCase()}`).slice(0, 16)}`,
    codeHash: sha(code),
  });
  // Mock bank only: there is no statement to read the code from, so the app shows it (labelled simulated).
  return startResponse(userId, row, bankMode() === "mock" ? code : undefined);
}

/** Saves a Stripe test card for off-session charges: one Stripe customer per user, reused for every card. */
async function saveStripeCard(userId: string, row: FundingSourceRow): Promise<{ providerRef: string; providerCustomer: string }> {
  const db = getDb();
  const existing = (await db.select({ c: fundingSources.providerCustomer }).from(fundingSources).where(and(eq(fundingSources.userId, userId), isNotNull(fundingSources.providerCustomer))))[0];
  const customer = existing?.c ?? (await stripe().customers.create({ description: "Kassa test customer", metadata: { kassaUserId: userId } }, { idempotencyKey: `kassa-customer-${userId}` })).id;
  const si = await stripe().setupIntents.create(
    {
      customer,
      payment_method: row.providerRef!,
      confirm: true,
      usage: "off_session",
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: { kassaUserId: userId, kassaFundingSource: row.id },
    },
    { idempotencyKey: `kassa-link-${row.id}` },
  );
  if (si.status !== "succeeded" || typeof si.payment_method !== "string") throw new HttpProblem(402, "CARD_LINK_FAILED", `Stripe could not save the card (${si.status})`);
  return { providerRef: si.payment_method, providerCustomer: customer };
}

export async function confirmLink(userId: string, id: string, body: { code?: string | undefined; challengeId?: string | undefined; assertion?: unknown }) {
  const db = getDb();
  const row = await ownSource(userId, id);
  if (row.status === "ACTIVE") return row;
  if (row.kind === "BANK") {
    if (!body.code) throw new HttpProblem(422, "CODE_REQUIRED", "Enter the 4-digit code from the 1 ₸ payment");
    if (row.codeAttempts >= MAX_CODE_ATTEMPTS) throw conflict("CODE_LOCKED", "Too many wrong codes; remove this account and link it again");
    if (sha(body.code) !== row.codeHash) {
      await db.update(fundingSources).set({ codeAttempts: row.codeAttempts + 1 }).where(eq(fundingSources.id, row.id));
      throw new HttpProblem(422, "CODE_WRONG", "That code does not match");
    }
  }
  if (!body.challengeId || !body.assertion) {
    const challengeId = await putGated({ userId, purpose: "funding-link", hash: row.linkHash, payload: { sourceId: row.id } });
    throw new HttpProblem(428, "PASSKEY_REQUIRED", `Confirm ${labelOf(row)} with your passkey`, {
      reasonCodes: ["PASSKEY_REQUIRED"],
      details: { challengeId, webauthnOptions: await assertionOptions(db, userId, row.linkHash) },
    });
  }
  const gated = await takeGated(body.challengeId, userId, "funding-link");
  if (!gated || (gated.payload as { sourceId?: string } | null)?.sourceId !== row.id || gated.hash !== row.linkHash) {
    throw conflict("CHALLENGE_MISMATCH", "The signed request no longer matches this account; start again");
  }
  const check = await verifyRulesAssertion(db, { userId, assertion: body.assertion, expectedChallenge: gated.hash, challengeReason: "ASSERTION_INVALID" });
  if (!check.ok) {
    await auditAssertionFailure(userId, "funding-link", check.reason);
    throw new HttpProblem(403, "PASSKEY_REQUIRED", check.detail, { reasonCodes: ["PASSKEY_REQUIRED", check.reason] });
  }
  const saved = row.kind === "CARD" && !row.simulated ? await saveStripeCard(userId, row) : null;
  const now = clock.now();
  const updated = (
    await db
      .update(fundingSources)
      .set({ status: "ACTIVE", verifiedAt: now, codeHash: null, ...(saved ?? {}) })
      .where(and(eq(fundingSources.id, row.id), eq(fundingSources.status, "PENDING")))
      .returning()
  )[0];
  if (!updated) throw conflict("CHALLENGE_MISMATCH", "This account changed while you were confirming it; start again");
  await ledger.append("FUNDING_SOURCE_LINKED", { userId, sourceId: row.id, kind: row.kind, provider: row.provider, currency: row.currency, simulated: row.simulated, linkHash: row.linkHash, credentialId: check.credentialId, ...(await sealPii(userId, { name: labelOf(row) })) });
  return updated;
}

export async function removeFundingSource(userId: string, id: string): Promise<void> {
  const row = await ownSource(userId, id);
  const now = clock.now();
  await getDb().update(fundingSources).set({ status: "REMOVED", removedAt: now }).where(eq(fundingSources.id, row.id));
  // The saved test card is detached at Stripe too; failure there leaves it unusable here anyway.
  if (row.kind === "CARD" && !row.simulated && row.providerRef?.startsWith("pm_") && row.verifiedAt) {
    await stripe()
      .paymentMethods.detach(row.providerRef)
      .catch(() => undefined);
  }
  await ledger.append("FUNDING_SOURCE_REMOVED", { userId, sourceId: row.id, kind: row.kind });
}
