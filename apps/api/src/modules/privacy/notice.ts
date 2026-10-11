/*
 * AI transparency notice (EU AI Act Regulation (EU) 2024/1689 Art. 50(1): people are informed that they
 * interact with an AI system; GDPR Art. 13(1)(e)–(f): recipients and transfers) and the consent gate for AI
 * processing (GDPR Art. 6(1)(a), Art. 7: freely given, withdrawable at any time — POST /privacy/ai-consent).
 *
 * What each model sees (spec §9, I10, I11):
 *  - Planner: the user's chat text and tool results AFTER personal-data reduction (names, IBANs, card numbers,
 *    emails, phone numbers become placeholders; the server keeps the map).
 *  - Reader: the raw text/image of a document the user uploaded or a message to parse. It has no tools and no
 *    memory and its output is schema-checked against the source (I10); it needs the raw text to extract the
 *    amount and account, so documents are NOT redacted before the Reader (documented in docs/PRIVACY.md).
 */
import type { AiNotice } from "@kassa/shared";
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

export function aiNotice(): AiNotice {
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
      "You can withdraw your consent at any time in Settings > Privacy.",
    planner,
    reader,
    plannerReceives: ["chat messages (reduced)", "tool results: balances, budgets, obligations, payee facts (reduced)"],
    readerReceives: ["text or image of documents and messages you ask Kassa to read"],
    redacted: ["your name", "payee names", "IBANs and account numbers", "card numbers", "email addresses", "phone numbers"],
    canPay: false,
    consentRequired: true,
  };
}

/**
 * preHandler for AI routes (agent chat, document upload, onboarding chat): consent given and processing not
 * restricted (GDPR Art. 18). Runs after the session check.
 */
export async function requireAiConsent(req: FastifyRequest): Promise<void> {
  const userId = userIdOf(req);
  const u = (await getDb().select({ aiConsentAt: users.aiConsentAt, restrictedAt: users.restrictedAt }).from(users).where(eq(users.id, userId)))[0];
  if (u?.restrictedAt) {
    throw new HttpProblem(403, "PROCESSING_RESTRICTED", "You restricted processing of your data (GDPR Art. 18)", { reasonCodes: ["PROCESSING_RESTRICTED"] });
  }
  if (!u?.aiConsentAt) {
    throw new HttpProblem(403, "AI_CONSENT_REQUIRED", "Agree to AI processing first (POST /privacy/ai-consent)", {
      reasonCodes: ["AI_CONSENT_REQUIRED"],
      details: { aiNotice: aiNotice() },
    });
  }
}
