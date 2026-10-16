/*
 * (added 2026-10-16) Identity check (KYC), sandbox.
 *
 *  - startCheck: sends the fictitious document, the account's display name and the simulated liveness result to the
 *    identity checker (mock-world /kyc/checks; in production a licensed partner's KYC service) and records the
 *    outcome. Stored: outcome, the checker's reason codes, document type and country, timestamps, and the last 4
 *    characters of the number sealed with the user's data key. Never stored or logged: the full number, the name, the
 *    date of birth (they exist only in this request). Each outcome is a ledger entry (KYC_VERIFIED, KYC_REVIEW,
 *    KYC_REJECTED) with the same minimal fields.
 *  - kycView: GET /kyc, the user's standing and the threshold above which it matters.
 *
 * A signed-in user is enough to start a check: it only adds information and loosens no signed rule. Above the
 * threshold every payment still needs its passkey (or a signed mandate) and stays inside the passkey-signed caps.
 * Enforcement lives in rules (decide, KYC_REQUIRED), payments (its own re-check) and the wallet top-up.
 */
import { type KycCheckDto, KycDocumentType, KycOutcome, KycReason, type KycStartRequest, type KycStatusResponse } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { kycChecks, users } from "../../db/schema.ts";
import { HttpProblem, notFound } from "../../http/problem.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { sealPii } from "../privacy/keys.ts";
import { mockWorld } from "../rails/http.ts";
import { latestKycCheck, toKycDto } from "./status.ts";
import { kycThresholdInHome } from "./threshold.ts";

const CheckerAnswer = z.object({
  checkId: z.string().min(1).max(80),
  outcome: KycOutcome,
  reasonCodes: z.array(KycReason),
  document: z.object({ type: KycDocumentType, country: z.string().regex(/^[A-Z]{2}$/), last4: z.string().max(4) }),
  checkedAt: z.string().datetime(),
  provider: z.string().min(1).max(40),
  simulated: z.literal(true),
});

async function userOf(userId: string) {
  const u = (await getDb().select({ displayName: users.displayName, homeCurrency: users.homeCurrency, erasedAt: users.erasedAt }).from(users).where(eq(users.id, userId)))[0];
  if (!u) throw notFound("user");
  return u;
}

export async function kycView(userId: string): Promise<KycStatusResponse> {
  const u = await userOf(userId);
  const latest = await latestKycCheck(getDb(), userId);
  return {
    status: latest?.outcome ?? "NONE",
    latest: latest ? await toKycDto(latest) : null,
    thresholdHomeMinor: await kycThresholdInHome(u.homeCurrency, clock.now()),
    homeCurrency: u.homeCurrency,
    simulated: true,
  };
}

export async function startCheck(userId: string, req: KycStartRequest): Promise<KycCheckDto> {
  const u = await userOf(userId);
  if (u.erasedAt) throw new HttpProblem(409, "ACCOUNT_ERASED", "This account was erased", { reasonCodes: ["ACCOUNT_ERASED"] });
  let raw: unknown;
  try {
    raw = await mockWorld("POST", "/kyc/checks", { accountName: u.displayName, document: req.document, liveness: req.liveness });
  } catch {
    throw new HttpProblem(503, "KYC_UNAVAILABLE", "The identity checker is not answering; try again shortly");
  }
  const parsed = CheckerAnswer.safeParse(raw);
  if (!parsed.success) throw new HttpProblem(502, "KYC_INVALID_ANSWER", "The identity checker sent something unexpected");
  const a = parsed.data;
  const now = clock.now();
  const db = getDb();
  const row = await db.transaction(async (tx) => {
    const sealed = await sealPii(userId, { documentLast4: a.document.last4 }, tx);
    const inserted = await tx
      .insert(kycChecks)
      .values({
        userId,
        outcome: a.outcome,
        reasonCodes: a.reasonCodes,
        documentType: a.document.type,
        documentCountry: a.document.country,
        pii: "pii" in sealed ? sealed.pii : null,
        provider: a.provider,
        providerRef: a.checkId,
        simulated: a.simulated,
        createdAt: now,
        checkedAt: new Date(a.checkedAt),
      })
      .returning();
    const r = inserted[0]!;
    await ledger.append(
      `KYC_${a.outcome}`,
      { userId, kycCheckId: r.id, outcome: a.outcome, reasonCodes: a.reasonCodes, documentType: a.document.type, documentCountry: a.document.country, provider: a.provider, providerRef: a.checkId, simulated: true, ...sealed },
      tx,
    );
    return r;
  });
  return toKycDto(row);
}
