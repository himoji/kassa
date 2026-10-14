import { ApiError as ApiErrorBody, ReasonCode, type PasskeyChallenge } from "@kassa/shared";
import { PasskeyChallenge as PasskeyChallengeSchema } from "@kassa/shared";

/**
 * A non-2xx answer from the Kassa API. The body follows the shared `ApiError` shape; `code` is a
 * ReasonCode when the refusal is a rule outcome (the app translates codes, the server sends no prose).
 */
export class KassaApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly reasonCodes: ReasonCode[];
  readonly details: unknown;

  constructor(status: number, body: unknown) {
    const parsed = ApiErrorBody.safeParse(body);
    super(parsed.success ? parsed.data.error : `HTTP ${status}`);
    this.name = "KassaApiError";
    this.status = status;
    this.code = parsed.success ? parsed.data.code : undefined;
    this.reasonCodes = parsed.success ? (parsed.data.reasonCodes ?? []) : [];
    this.details = parsed.success ? parsed.data.details : undefined;
  }

  /** All reason codes carried by this error (`code` first when it is one). */
  get allReasonCodes(): ReasonCode[] {
    const first = ReasonCode.safeParse(this.code);
    const codes = first.success ? [first.data, ...this.reasonCodes] : this.reasonCodes;
    return [...new Set(codes)];
  }

  /**
   * The server has no such route at all (Fastify's not-found handler: "No route GET /api/..."): it runs older code than
   * this app, so a screen added since then cannot load until the server is redeployed.
   */
  get missingRoute(): boolean {
    return this.status === 404 && this.message.startsWith("No route ");
  }

  /** HTTP 428 + PASSKEY_REQUIRED: the server wants a passkey assertion over `challenge` (I8). */
  get passkeyChallenge(): PasskeyChallenge | null {
    if (this.status !== 428 || this.code !== "PASSKEY_REQUIRED") return null;
    const parsed = PasskeyChallengeSchema.safeParse(this.details);
    return parsed.success ? parsed.data : null;
  }
}

/** The response did not match the shared contract (zod). Shown as a generic error, logged in dev. */
export class ContractError extends Error {
  readonly path: string;
  readonly issues: unknown;

  constructor(path: string, issues: unknown) {
    super(`Response from ${path} does not match the contract`);
    this.name = "ContractError";
    this.path = path;
    this.issues = issues;
  }
}

/** No network / timeout / CORS: the request never produced an HTTP status. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Network request failed");
    this.name = "NetworkError";
  }
}

export function isUnauthorized(err: unknown): boolean {
  return err instanceof KassaApiError && err.status === 401;
}
