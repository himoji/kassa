/*
 * AI transparency notice (EU AI Act Regulation (EU) 2024/1689 Art. 50(1): people are informed that they
 * interact with an AI system; GDPR Art. 13(1)(e)–(f): recipients and transfers) and the consent gate for AI
 * processing (GDPR Art. 6(1)(a), Art. 7: freely given, withdrawable at any time — POST /privacy/ai-consent), plus
 * the separate cross-border consent for region CN (PIPL Art. 38–39 — POST /privacy/pipl-consent).
 *
 * What each model sees (spec §9, I10, I11):
 *  - Planner: the user's chat text and tool results AFTER personal-data reduction (names, IBANs, card numbers,
 *    emails, phone numbers become placeholders; the server keeps the map).
 *  - Reader: the raw text/image of a document the user uploaded or a message to parse. It has no tools and no
 *    memory and its output is schema-checked against the source (I10); it needs the raw text to extract the
 *    amount and account, so documents are NOT redacted before the Reader (documented in docs/security/privacy.md).
 */
import type { AiNotice, Region } from "@kassa/shared";
import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { users } from "../../db/schema.ts";
import { HttpProblem } from "../../http/problem.ts";
import { plannerSpec, readerSpec } from "../ai/models.ts";
import type { ModelSpec } from "../ai/registry.ts";
import { userIdOf } from "../auth/session.ts";

export const AI_NOTICE_VERSION = "2026-10-11";

const LOCAL_PROVIDERS = new Set(["local", "ollama"]);

function info(spec: () => ModelSpec): AiNotice["planner"] {
  try {
    const s = spec();
    return { provider: s.provider, model: s.modelId, local: LOCAL_PROVIDERS.has(s.provider) };
  } catch {
    // Misconfigured model env: the notice still renders; the agent itself will refuse with AI_* errors.
    return { provider: "unconfigured", model: "unconfigured", local: false };
  }
}

/**
 * Region line (docs/architecture/decisions.md 2026-10-12 "Per-region AI notice", 2026-10-12 "PIPL separate consent"). CN: PIPL
 * (Personal Information Protection Law of the PRC) Art. 38–39 — personal information leaving mainland China is a
 * cross-border transfer that needs the person to be told the recipient and to give separate consent (Art. 39).
 * Kassa asks for it separately (POST /privacy/pipl-consent); without it the AI routes answer 403
 * PIPL_CONSENT_REQUIRED (assertAiProcessingAllowed).
 */
function externalProviders(planner: AiNotice["planner"], reader: AiNotice["reader"]): string[] {
  return [...new Set([planner, reader].filter((m) => !m.local).map((m) => m.provider))];
}

function regionLine(region: Region, planner: AiNotice["planner"], reader: AiNotice["reader"]): string {
  if (region !== "CN") return "";
  const external = externalProviders(planner, reader);
  if (external.length === 0) {
    return " Region CN (PIPL): AI processing stays on Kassa's own server, so the AI step involves no cross-border transfer of your personal information.";
  }
  return (
    ` Region CN (PIPL): ${external.join(" and ")} may process your reduced chat and the documents you upload outside ` +
    "mainland China. Under PIPL Art. 38–39 this is a cross-border transfer of personal information, so Kassa asks for your " +
    "separate consent before the assistant or the document reader runs (Settings > Privacy > Cross-border AI processing); " +
    "you can withdraw it there at any time. Choose a local model to keep AI processing on Kassa's own server."
  );
}

/** Region CN and a model outside Kassa's server: the separate PIPL consent is needed (Art. 38–39). */
export function crossBorderConsentRequired(region: Region): boolean {
  if (region !== "CN") return false;
  const n = { planner: info(() => plannerSpec()), reader: info(() => readerSpec()) };
  return externalProviders(n.planner, n.reader).length > 0;
}

/** `region` adds the per-region line (CN: PIPL cross-border transfer); default EU (no extra line). */
export function aiNotice(region: Region = "EU"): AiNotice {
  const planner = info(() => plannerSpec());
  const reader = info(() => readerSpec());
  const where = (m: AiNotice["planner"]) => (m.local ? "a model running on our own server" : `${m.provider} (${m.model}), an external AI provider`);
  return {
    isAiSystem: true,
    noticeVersion: AI_NOTICE_VERSION,
    text:
      `You are talking to an AI assistant, not a person. Your chat is processed by ${where(planner)}; ` +
      `documents you upload are read by ${where(reader)}. Before anything reaches the chat model, names, ` +
      "account and card numbers, emails and phone numbers are replaced by placeholders. The AI can only " +
      "propose payments: every payment is checked by fixed rules and needs your passkey or a mandate you signed. " +
      "You can withdraw your consent at any time in Settings > Privacy." +
      regionLine(region, planner, reader),
    planner,
    reader,
    plannerReceives: ["chat messages (reduced)", "tool results: balances, budgets, obligations, payee facts (reduced)"],
    readerReceives: ["text or image of documents and messages you ask Kassa to read"],
    redacted: ["your name", "payee names", "IBANs and account numbers", "card numbers", "email addresses", "phone numbers"],
    canPay: false,
    consentRequired: true,
    ...(region === "CN" ? { crossBorderConsentRequired: externalProviders(planner, reader).length > 0 } : {}),
  };
}

/**
 * The AI-processing gate for one user (agent chat, document upload/reading, onboarding chat, the sim planner):
 * processing not restricted (GDPR Art. 18), AI consent given (GDPR Art. 6(1)(a)/7), and for region CN with an
 * external model the separate cross-border consent (PIPL Art. 38–39). Throws the 403 problem; resolves otherwise.
 */
export async function assertAiProcessingAllowed(userId: string): Promise<void> {
  const u = (
    await getDb()
      .select({ aiConsentAt: users.aiConsentAt, piplConsentAt: users.piplConsentAt, restrictedAt: users.restrictedAt, region: users.region })
      .from(users)
      .where(eq(users.id, userId))
  )[0];
  if (u?.restrictedAt) {
    throw new HttpProblem(403, "PROCESSING_RESTRICTED", "You restricted processing of your data (GDPR Art. 18)", { reasonCodes: ["PROCESSING_RESTRICTED"] });
  }
  if (!u?.aiConsentAt) {
    throw new HttpProblem(403, "AI_CONSENT_REQUIRED", "Agree to AI processing first (POST /privacy/ai-consent)", {
      reasonCodes: ["AI_CONSENT_REQUIRED"],
      details: { aiNotice: aiNotice(u?.region ?? "EU") },
    });
  }
  if (!u.piplConsentAt && crossBorderConsentRequired(u.region)) {
    throw new HttpProblem(
      403,
      "PIPL_CONSENT_REQUIRED",
      "AI processing for region CN is a cross-border transfer of personal information: give your separate consent first (PIPL Art. 38–39; POST /privacy/pipl-consent)",
      { reasonCodes: ["PIPL_CONSENT_REQUIRED"], details: { aiNotice: aiNotice(u.region) } },
    );
  }
}

/**
 * The same gate as a boolean over a users row, for background AI steps that must silently skip instead of failing
 * (capture's Reader fallbacks): no AI processing without consent, under a restriction, or (CN) without PIPL consent.
 */
export function aiProcessingAllowedFor(u: { aiConsentAt: Date | null; piplConsentAt: Date | null; restrictedAt: Date | null; region: Region }): boolean {
  if (u.restrictedAt || !u.aiConsentAt) return false;
  return !!u.piplConsentAt || !crossBorderConsentRequired(u.region);
}

/** preHandler for AI routes: assertAiProcessingAllowed for the session user. Runs after the session check. */
export async function requireAiConsent(req: FastifyRequest): Promise<void> {
  await assertAiProcessingAllowed(userIdOf(req));
}
