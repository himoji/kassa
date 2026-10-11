import { randomUUID } from "node:crypto";

import { mockWebhookHeaders } from "@kassa/shared";

import type { Clock, FetchLike } from "../clock.ts";

/*
 * How the Pizza Shop in Budapest "charges" a one-time card (spec §11 steps 4 and 7):
 * - stripe: Stripe test helper POST /v1/test_helpers/issuing/authorizations (form-encoded; params
 *   card, amount, currency, merchant_data[...], per docs.stripe.com/api/issuing/authorizations/
 *   test_mode_create). Stripe then calls the API's issuing_authorization.request webhook, which
 *   approves or declines; the response's `approved` carries that decision.
 * - fake: POST {API_URL}/api/rails/fake-issuing/authorize, HMAC-signed like the mock webhooks
 *   (contract in PHASE1_COORDINATION.md "Contract changes"). Same decision logic, local cards.
 * Both fail closed: if the issuer cannot be reached, the charge is declined.
 */

export interface AuthorizationRequest {
  cardId: string;
  amountMinor: number;
  currency: string;
  merchant: { name: string; mcc: string; stripeCategory: string; city: string; country: string };
}

export interface AuthorizationResult {
  approved: boolean;
  provider: "stripe" | "fake";
  authorizationId: string | null;
  reasonCode: string | null;
  /** HTTP status from the issuer, for debugging the demo. */
  issuerStatus: number | null;
}

export interface Issuer {
  readonly provider: "stripe" | "fake";
  authorize(req: AuthorizationRequest): Promise<AuthorizationResult>;
}

export class FakeIssuerClient implements Issuer {
  readonly provider = "fake" as const;

  constructor(
    private readonly opts: { apiUrl: string; secret: string; clock: Clock; fetch?: FetchLike; timeoutMs?: number },
  ) {}

  async authorize(req: AuthorizationRequest): Promise<AuthorizationResult> {
    const now = await this.opts.clock.now();
    const authorizationId = randomUUID();
    const rawBody = JSON.stringify({
      authorizationId,
      cardId: req.cardId,
      amountMinor: req.amountMinor,
      currency: req.currency,
      merchant: { name: req.merchant.name, mcc: req.merchant.mcc, city: req.merchant.city, country: req.merchant.country },
      occurredAt: now.toISOString(),
    });
    try {
      const res = await (this.opts.fetch ?? fetch)(`${this.opts.apiUrl}/api/rails/fake-issuing/authorize`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...mockWebhookHeaders(this.opts.secret, rawBody, Math.floor(now.getTime() / 1000)),
        },
        body: rawBody,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 3000),
      });
      const body = (await res.json().catch(() => null)) as { approved?: unknown; reasonCode?: unknown } | null;
      const approved = res.ok && body?.approved === true;
      return {
        approved,
        provider: "fake",
        authorizationId,
        reasonCode: approved ? null : typeof body?.reasonCode === "string" ? body.reasonCode : `ISSUER_HTTP_${res.status}`,
        issuerStatus: res.status,
      };
    } catch {
      return { approved: false, provider: "fake", authorizationId, reasonCode: "ISSUER_UNAVAILABLE", issuerStatus: null };
    }
  }
}

export class StripeTestHelperClient implements Issuer {
  readonly provider = "stripe" as const;

  constructor(private readonly opts: { secretKey: string; apiBase: string; fetch?: FetchLike; timeoutMs?: number }) {
    if (!opts.secretKey.startsWith("sk_test_")) throw new Error("Stripe test helpers need a test-mode key (sk_test_...)");
  }

  async authorize(req: AuthorizationRequest): Promise<AuthorizationResult> {
    if (!req.cardId.startsWith("ic_")) {
      return { approved: false, provider: "stripe", authorizationId: null, reasonCode: "NOT_A_STRIPE_CARD", issuerStatus: null };
    }
    const form = new URLSearchParams({
      card: req.cardId,
      amount: String(req.amountMinor),
      currency: req.currency.toLowerCase(),
      "merchant_data[name]": req.merchant.name,
      "merchant_data[category]": req.merchant.stripeCategory,
      "merchant_data[city]": req.merchant.city,
      "merchant_data[country]": req.merchant.country,
    });
    try {
      const res = await (this.opts.fetch ?? fetch)(`${this.opts.apiBase}/v1/test_helpers/issuing/authorizations`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.opts.secretKey}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      const body = (await res.json().catch(() => null)) as {
        id?: string;
        approved?: boolean;
        error?: { code?: string; message?: string };
      } | null;
      if (!res.ok) {
        return {
          approved: false,
          provider: "stripe",
          authorizationId: null,
          reasonCode: body?.error?.code ?? `STRIPE_HTTP_${res.status}`,
          issuerStatus: res.status,
        };
      }
      const approved = body?.approved === true;
      return {
        approved,
        provider: "stripe",
        authorizationId: body?.id ?? null,
        reasonCode: approved ? null : "DECLINED_BY_ISSUER",
        issuerStatus: res.status,
      };
    } catch {
      return { approved: false, provider: "stripe", authorizationId: null, reasonCode: "ISSUER_UNAVAILABLE", issuerStatus: null };
    }
  }
}
