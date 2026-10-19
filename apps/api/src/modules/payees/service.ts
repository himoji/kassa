/*
 * Payees (I7): every new payee — and every account change, which IS a new payee — starts COOLING for
 * 24 h on the Clock. Cooling payees are never usable on autopilot (T1) and need a passkey (T2) after
 * coolingUntil. The account is stored AES-256-GCM encrypted plus its hash (payees/crypto.ts).
 */
import { categoryOfKind, decodePayeeAccount, detailsFitKind, isSupportedCurrency, jcsHash, normalizeKassaId, validatePayeeAccount, type CreatePayeeRequest, type PayeeDto, type PayPayeeRequest, type RecipientDetails } from "@kassa/shared";
import { and, eq, isNull } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";

import { getDb } from "../../db/client.ts";
import { obligations, payees } from "../../db/schema.ts";
import { auditAssertionFailure, ownedNotFound } from "../../http/audit.ts";
import { conflict, HttpProblem, notFound } from "../../http/problem.ts";
import { putGated, takeGated } from "../auth/challenges.ts";
import { addMs, clock, DAY_MS } from "../clock/index.ts";
import { waitMs } from "../demo/cooling.ts";
import { ledger } from "../ledger/index.ts";
import { sealPii } from "../privacy/keys.ts";
import { notify } from "../notifications/service.ts";
import { assertionOptions, verifyRulesAssertion } from "../rules/webauthn.ts";
import { screenName } from "../screening/index.ts";
import { proposeOrder } from "../rules/index.ts";
import { portalLinkFor } from "../schools/portal.ts";
import { kassaIdFor, userByKassaId } from "../wallet/service.ts";
import { accountHash, decryptAccount, encryptAccount, encryptDetails, maskAccount, normalizeAccount, readDetails } from "./crypto.ts";

export const COOLING_MS = DAY_MS;

const ACCOUNT_PROBLEM_TEXT: Record<string, string> = {
  ALIPAY_ID_INVALID: "An Alipay ID is the account's email or its mainland China mobile number",
  UNIONPAY_CARD_INVALID: "A UnionPay card number starts with 62, has 16 to 19 digits and a valid check digit",
  ACH_ROUTING_INVALID: "The ABA routing number must be 9 digits with a valid checksum",
  ACH_ACCOUNT_INVALID: "The US account number must be 4 to 17 digits",
  ACCOUNT_TOO_SHORT: "The account must have at least 4 characters",
  KASSA_ID_INVALID: "A Kassa ID looks like KSA-7QMX-2HVA",
  SCHEME_CURRENCY_MISMATCH: "This kind of account cannot receive that currency (Alipay and UnionPay take CNY, ACH takes USD, Kassa wallets take KZT, HUF, EUR, USD and CNY)",
};

export function toPayeeDto(p: typeof payees.$inferSelect): PayeeDto {
  const accountMissing = p.accountEnc === null;
  let masked = accountMissing ? "" : "••••";
  try {
    if (p.accountEnc !== null) {
      const account = decryptAccount(p.userId, p.accountEnc, p.id);
      // A merchant's "account" is its normalised name for card/QR matching, not a bank account: say what it is
      // instead of masking the end of the name ("•••• OPIN").
      masked = p.kind === "MERCHANT" && decodePayeeAccount(account).scheme === "OTHER" ? "card or QR" : maskAccount(account);
    }
  } catch {
    // undecryptable (key rotated): show nothing rather than fail the list
  }
  const details = readDetails(p);
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    accountMasked: masked,
    accountMissing,
    country: p.country,
    currency: p.currency,
    status: p.status,
    verifiedAt: p.verifiedAt?.toISOString() ?? null,
    coolingUntil: p.coolingUntil?.toISOString() ?? null,
    replacesPayeeId: p.replacesPayeeId,
    category: categoryOfKind(p.kind),
    details,
    portalLink: portalLinkFor(details),
  };
}

/** The user's recipients, without the ones they removed. */
export async function listPayees(userId: string) {
  return getDb().select().from(payees).where(and(eq(payees.userId, userId), isNull(payees.archivedAt)));
}

function assertDetailsFit(kind: CreatePayeeRequest["kind"], details: RecipientDetails | null | undefined) {
  if (details && !detailsFitKind(kind, details)) {
    throw new HttpProblem(422, "DETAILS_CATEGORY_MISMATCH", `These details are for ${details.category.toLowerCase()}, not for this kind of recipient`, { details: { field: "details" } });
  }
}

async function ownedPayee(userId: string, payeeId: string) {
  const db = getDb();
  const p = (await db.select().from(payees).where(and(eq(payees.id, payeeId), eq(payees.userId, userId), isNull(payees.archivedAt))))[0];
  if (!p) throw await ownedNotFound(userId, "payee", payeeId, async () => (await db.select({ id: payees.id }).from(payees).where(eq(payees.id, payeeId))).length > 0);
  return p;
}

/**
 * (2026-10-19) A tuition recipient's `portalSchoolId` says the school confirmed this student to Kassa ("Find your
 * school", schools/service.ts), which lets Kassa read the student's invoices without asking again. Only that flow sets
 * it (`portalSchoolId`); whatever a client sends is ignored. An edit keeps the link while the student ID stays the
 * same and drops it when the student ID changes.
 */
function withPortalLink(details: RecipientDetails | null, previous: RecipientDetails | null, portalSchoolId?: string): RecipientDetails | null {
  if (details?.category !== "TUITION") return details;
  const { portalSchoolId: _ignored, ...rest } = details;
  const kept = previous?.category === "TUITION" && previous.portalSchoolId && previous.studentId.toUpperCase() === details.studentId.toUpperCase() ? previous.portalSchoolId : undefined;
  const link = portalSchoolId ?? kept;
  return link ? { ...rest, portalSchoolId: link } : rest;
}

/**
 * Edit a recipient's details (student ID, customer number, relationship…). Where the money goes (account, name,
 * currency) never changes here: that is a new payee with replacesPayeeId and a new cooling period (I7).
 */
export async function updatePayeeDetails(userId: string, payeeId: string, input: RecipientDetails | null, opts: { portalSchoolId?: string } = {}) {
  const p = await ownedPayee(userId, payeeId);
  assertDetailsFit(p.kind, input);
  const details = withPortalLink(input, readDetails(p), opts.portalSchoolId);
  const db = getDb();
  return db.transaction(async (tx) => {
    const r = await tx
      .update(payees)
      .set({ detailsEnc: details ? encryptDetails(userId, details) : null })
      .where(eq(payees.id, p.id))
      .returning();
    await ledger.append("PAYEE_DETAILS_UPDATED", { userId, payeeId: p.id, category: categoryOfKind(p.kind), cleared: details === null }, tx);
    return r[0]!;
  });
}

/**
 * Remove a recipient: hidden from lists and refused by the rules and the payment executor from now on. Its bills
 * would keep proposing payments nobody can make, so a recipient with bills is refused until they are removed.
 */
export async function archivePayee(userId: string, payeeId: string) {
  const p = await ownedPayee(userId, payeeId);
  const db = getDb();
  const bills = await db.select({ id: obligations.id }).from(obligations).where(eq(obligations.payeeId, p.id));
  if (bills.length > 0) {
    throw conflict("PAYEE_HAS_BILLS", `Remove the ${bills.length === 1 ? "bill" : "bills"} for ${p.name} first`, { details: { obligationIds: bills.map((b) => b.id) } });
  }
  await db.transaction(async (tx) => {
    await tx.update(payees).set({ archivedAt: clock.now() }).where(eq(payees.id, p.id));
    await ledger.append("PAYEE_ARCHIVED", { userId, payeeId: p.id }, tx);
  });
}

export async function createPayee(userId: string, req: CreatePayeeRequest & { source?: string }) {
  const db = getDb();
  // Per-scheme checks (shared/payeeAccount.ts): IBAN check digits, Alipay ID shape, UnionPay Luhn, ABA routing
  // checksum, and a currency the scheme can actually pay out in (Alipay/UnionPay → CNY, ACH → USD).
  const problem = validatePayeeAccount(decodePayeeAccount(req.account), req.currency);
  if (problem?.code === "IBAN_INVALID") {
    throw new HttpProblem(422, "INVALID_IBAN", "IBAN check digits are wrong (ISO 13616 / ISO 7064 MOD 97-10)", { details: { field: problem.field } });
  }
  if (problem) throw new HttpProblem(422, problem.code, ACCOUNT_PROBLEM_TEXT[problem.code], { details: { field: problem.field } });
  const fields = decodePayeeAccount(req.account);
  if (fields.scheme === "KASSA_USER") {
    // Another Kassa user's wallet: the ID must exist, must not be the user's own, and the currency one Kassa holds.
    const id = normalizeKassaId(fields.kassaId)!;
    if (id === kassaIdFor(userId)) throw new HttpProblem(422, "KASSA_ID_SELF", "That is your own Kassa ID", { details: { field: "kassaId" } });
    if (!(await userByKassaId(id))) throw new HttpProblem(422, "KASSA_ID_UNKNOWN", "No Kassa user has that ID", { details: { field: "kassaId" } });
    if (!isSupportedCurrency(req.currency)) throw new HttpProblem(422, "SCHEME_CURRENCY_MISMATCH", ACCOUNT_PROBLEM_TEXT.SCHEME_CURRENCY_MISMATCH, { details: { field: "currency" } });
  }
  if (!/^[A-Z]{2}$/.test(req.country)) throw new HttpProblem(422, "INVALID_COUNTRY", "country must be ISO 3166-1 alpha-2");
  assertDetailsFit(req.kind, req.details);
  // Only "Find your school" links a new recipient to the school's portal (withPortalLink).
  const details = req.source === "school-directory" ? (req.details ?? null) : withPortalLink(req.details ?? null, null);
  // I9 / X4: screen the name at creation. A hit is refused and not stored (a payee that can never be paid is no
  // use); the hit is ledgered with the name sealed under the user's key (GDPR Art. 17 crypto-shredding).
  const screening = screenName(req.name);
  if (screening.hit) {
    await ledger.append("PAYEE_SCREENING_HIT", {
      userId,
      reasonCodes: ["REFUSE_SANCTIONS"],
      entryId: screening.entryId,
      score: Math.round(screening.score * 10_000) / 10_000,
      source: req.source ?? "user",
      ...(await sealPii(userId, { name: req.name })),
    });
    throw new HttpProblem(422, "REFUSE_SANCTIONS", "This name matches a sanctions list entry; the recipient was not added", { reasonCodes: ["REFUSE_SANCTIONS"] });
  }
  if (req.replacesPayeeId) {
    const old = (await db.select().from(payees).where(and(eq(payees.id, req.replacesPayeeId), eq(payees.userId, userId))))[0];
    if (!old) throw notFound("replaced payee");
  }
  const now = clock.now();
  // The demo switch can drop the wait for this user (demo/cooling.ts); the payee still starts COOLING (T2 only).
  const coolingUntil = addMs(now, await waitMs(userId, COOLING_MS));
  // A12: the id is chosen here so the account ciphertext is bound to this row (payees/crypto.ts v2).
  const id = randomUUID();
  const rows = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(payees)
      .values({
        id,
        userId,
        name: req.name.trim(),
        kind: req.kind,
        accountEnc: encryptAccount(userId, normalizeAccount(req.account), id),
        accountHash: accountHash(req.account),
        country: req.country,
        currency: req.currency,
        status: "COOLING",
        verifiedAt: null,
        coolingUntil,
        replacesPayeeId: req.replacesPayeeId ?? null,
        detailsEnc: details ? encryptDetails(userId, details) : null,
        createdAt: now,
      })
      .returning();
    const p = inserted[0]!;
    await ledger.append(
      "PAYEE_CREATED",
      // accountHash (sha256 of a third party's account) is sealed with the user's key: an IBAN space is small
      // enough to brute-force a bare hash, and erasure must make it unreadable (GDPR Art. 17).
      { userId, payeeId: p.id, status: "COOLING", coolingUntil: coolingUntil.toISOString(), replacesPayeeId: p.replacesPayeeId, source: req.source ?? "user", ...(await sealPii(userId, { accountHash: p.accountHash }, tx)) },
      tx,
    );
    return inserted;
  });
  const p = rows[0]!;
  await notify(userId, {
    kind: "PAYEE_COOLING",
    title: "New recipient is cooling",
    body: `${p.name} can be paid with your passkey after ${coolingUntil.toISOString()}. A changed account is a new recipient.`,
    data: { payeeId: p.id, coolingUntil: coolingUntil.toISOString(), replacesPayeeId: p.replacesPayeeId },
  });
  return p;
}

/** (X3) What the user signs to verify a payee: binds its id, name and account hash (PSD2 RTS Art. 5 dynamic linking). */
export type PayeeVerifyCore = { v: 1; kind: "PAYEE_VERIFY"; userId: string; payeeId: string; payeeName: string; accountHash: string; nonce: string };

/**
 * Simulated confirmation-of-payee callback (spec §8). Allowed only after the cooling period (I7), and (X3, security
 * review F1) only with a FRESH passkey assertion: a verified payee becomes eligible for small-auto payments, so a
 * stolen session must not be able to verify one. First call → HTTP 428 PASSKEY_REQUIRED with a challenge =
 * jcsHash(PayeeVerifyCore) (the nonce makes every challenge unique); resend with {challengeId, assertion}.
 */
export async function verifyCallback(userId: string, payeeId: string, body: { challengeId?: string | undefined; assertion?: unknown } = {}) {
  const db = getDb();
  const p = await ownedPayee(userId, payeeId);
  if (p.status === "VERIFIED") return p;
  if (p.status === "BLOCKED") throw conflict("REFUSE_UNVERIFIED_PAYEE", "Recipient is blocked");
  // A payee without account details (captured in onboarding) has nothing to confirm: verifying it would make an
  // account-less payee look payable. Checked before the cooling window (its coolingUntil is null).
  if (p.accountHash === null) {
    throw conflict("PAYEE_ACCOUNT_MISSING", "Add the recipient's account details first", { reasonCodes: ["REFUSE_UNVERIFIED_PAYEE", "PAYEE_ACCOUNT_MISSING"] });
  }
  const accountHashValue = p.accountHash;
  const now = clock.now();
  if (p.coolingUntil && p.coolingUntil.getTime() > now.getTime()) {
    throw conflict("PAYEE_COOLING", "Recipient is still cooling", { reasonCodes: ["PAYEE_COOLING"], details: { coolingUntil: p.coolingUntil.toISOString() } });
  }

  if (!body.challengeId || !body.assertion) {
    const core: PayeeVerifyCore = { v: 1, kind: "PAYEE_VERIFY", userId, payeeId: p.id, payeeName: p.name, accountHash: accountHashValue, nonce: randomBytes(16).toString("base64url") };
    const hash = jcsHash(core);
    const challengeId = await putGated({ userId, purpose: "payee-verify", hash, payload: core });
    throw new HttpProblem(428, "PASSKEY_REQUIRED", `Confirm ${p.name} with your passkey`, {
      reasonCodes: ["PASSKEY_REQUIRED"],
      details: { challengeId, webauthnOptions: await assertionOptions(db, userId, hash) },
    });
  }
  const gated = await takeGated(body.challengeId, userId, "payee-verify");
  const core = gated?.payload as PayeeVerifyCore | undefined;
  // The challenge must be for THIS payee, with the account it still has.
  if (!gated || !core || core.payeeId !== p.id || core.accountHash !== p.accountHash || core.payeeName !== p.name) {
    throw conflict("CHALLENGE_MISMATCH", "The signed request no longer matches this recipient; start again");
  }
  const check = await verifyRulesAssertion(db, { userId, assertion: body.assertion, expectedChallenge: gated.hash, challengeReason: "ASSERTION_INVALID" });
  if (!check.ok) {
    await auditAssertionFailure(userId, "payee-verify", check.reason);
    throw new HttpProblem(403, "PASSKEY_REQUIRED", check.detail, { reasonCodes: ["PASSKEY_REQUIRED", check.reason] });
  }
  const rows = await db.transaction(async (tx) => {
    const r = await tx
      .update(payees)
      .set({ status: "VERIFIED", verifiedAt: now })
      .where(and(eq(payees.id, payeeId), eq(payees.status, "COOLING")))
      .returning();
    if (r.length === 0) throw conflict("CHALLENGE_MISMATCH", "Recipient changed while you were confirming it; start again");
    await ledger.append("PAYEE_VERIFIED", { userId, payeeId, source: "verify-callback (simulated)", challengeHash: gated.hash, credentialId: check.credentialId }, tx);
    return r;
  });
  return rows[0]!;
}

/**
 * The user asks to pay one of their payees. Nothing is paid here: it is proposed like any agent draft (createdBy USER),
 * so cooling (I7), caps, the reserve and the passkey all apply, and the app opens the order to approve it.
 */
export async function payPayee(userId: string, payeeId: string, req: PayPayeeRequest) {
  const p = await ownedPayee(userId, payeeId);
  if (req.currency !== p.currency) throw new HttpProblem(422, "CURRENCY_MISMATCH", `${p.name} is paid in ${p.currency}`, { reasonCodes: ["CURRENCY_MISMATCH"] });
  const r = await proposeOrder({ userId, createdBy: "USER", payeeId: p.id, amountMinor: req.amountMinor, currency: req.currency, purpose: req.purpose, ...(req.fundingSourceId ? { fundingSourceId: req.fundingSourceId } : {}) });
  return {
    proposalId: r.proposalId,
    decision: r.decision,
    reasonCodes: r.reasonCodes,
    summary: r.summary,
    ...(r.paymentStatus !== undefined ? { paymentStatus: r.paymentStatus } : {}),
    ...(r.deliveredInMs !== undefined ? { deliveredInMs: r.deliveredInMs } : {}),
  };
}
