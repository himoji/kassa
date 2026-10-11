/**
 * Consent refusals from POST /agent/message (privacy/notice.ts on the server): 403 AI_CONSENT_REQUIRED (GDPR Art. 7)
 * or, for region CN, 403 PIPL_CONSENT_REQUIRED (separate cross-border consent, PIPL Art. 38–39). The AI SDK chat
 * transport throws an Error whose message is the raw response body, so the problem JSON is parsed from it.
 * Consent is never given silently: the chat shows the notice and an explicit "I agree" button.
 */
export type ConsentKind = "AI_CONSENT_REQUIRED" | "PIPL_CONSENT_REQUIRED";

export interface ConsentNeeded {
  code: ConsentKind;
  /** The server's AI notice text (incl. the PIPL line for CN), when the problem carried it. */
  noticeText: string | null;
  /** Endpoint (relative to the API base) that records this consent. */
  endpoint: "/privacy/ai-consent" | "/privacy/pipl-consent";
}

const ENDPOINT: Record<ConsentKind, ConsentNeeded["endpoint"]> = {
  AI_CONSENT_REQUIRED: "/privacy/ai-consent",
  PIPL_CONSENT_REQUIRED: "/privacy/pipl-consent",
};

export function consentNeeded(error: unknown): ConsentNeeded | null {
  if (!(error instanceof Error)) return null;
  let body: unknown;
  try {
    body = JSON.parse(error.message);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const code = (body as { code?: unknown }).code;
  if (code !== "AI_CONSENT_REQUIRED" && code !== "PIPL_CONSENT_REQUIRED") return null;
  const details = (body as { details?: { aiNotice?: { text?: unknown } } }).details;
  const text = details?.aiNotice?.text;
  return { code, noticeText: typeof text === "string" ? text : null, endpoint: ENDPOINT[code] };
}
