import { randomUUID } from "node:crypto";

import { mockWebhookHeaders } from "@kassa/shared";

import type { Clock, FetchLike } from "./clock.ts";

/*
 * Outgoing webhooks to the API: POST {API_URL}/api/webhooks/mock/{bank|qr|pos|remittance|shop|supplier|school}.
 * Each attempt is signed afresh (X-Kassa-Timestamp = demo-clock unix seconds,
 * X-Kassa-Signature = hex HMAC-SHA256 over `${ts}.${rawBody}`, RFC 2104) so retries stay inside
 * the API's 5-minute window. Deliveries are serialised in one queue so the API sees state changes
 * in the order they happened. Every attempt is kept in an in-memory outbox (evidence / debugging).
 */

export type WebhookKind = "bank" | "qr" | "pos" | "remittance" | "shop" | "supplier" | "school";

export interface OutboxEntry {
  id: string;
  kind: WebhookKind;
  url: string;
  body: unknown;
  createdAt: string;
  attempts: number;
  status: "pending" | "delivered" | "failed";
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
}

export interface WebhookSink {
  send(kind: WebhookKind, body: unknown): OutboxEntry;
}

export class WebhookClient implements WebhookSink {
  readonly outbox: OutboxEntry[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly opts: {
      apiUrl: string;
      secret: string;
      clock: Clock;
      fetch?: FetchLike;
      maxAttempts?: number;
      backoffMs?: number;
      timeoutMs?: number;
      outboxLimit?: number;
      log?: (msg: string, data?: Record<string, unknown>) => void;
    },
  ) {}

  send(kind: WebhookKind, body: unknown): OutboxEntry {
    const entry: OutboxEntry = {
      id: randomUUID(),
      kind,
      url: `${this.opts.apiUrl}/api/webhooks/mock/${kind}`,
      body,
      createdAt: new Date().toISOString(),
      attempts: 0,
      status: "pending",
      lastStatusCode: null,
      lastError: null,
      deliveredAt: null,
    };
    this.outbox.push(entry);
    const limit = this.opts.outboxLimit ?? 500;
    if (this.outbox.length > limit) this.outbox.splice(0, this.outbox.length - limit);
    this.chain = this.chain.then(() => this.deliver(entry));
    return entry;
  }

  /** Resolves when everything queued so far has been delivered or given up on. */
  idle(): Promise<void> {
    return this.chain;
  }

  private async deliver(entry: OutboxEntry): Promise<void> {
    const f = this.opts.fetch ?? fetch;
    const max = this.opts.maxAttempts ?? 4;
    const rawBody = JSON.stringify(entry.body);
    for (let attempt = 1; attempt <= max; attempt++) {
      entry.attempts = attempt;
      try {
        const nowSeconds = Math.floor((await this.opts.clock.now()).getTime() / 1000);
        const res = await f(entry.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...mockWebhookHeaders(this.opts.secret, rawBody, nowSeconds),
          },
          body: rawBody,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 3000),
        });
        entry.lastStatusCode = res.status;
        // Drain the body so the connection can be reused.
        await res.arrayBuffer().catch(() => undefined);
        if (res.ok) {
          entry.status = "delivered";
          entry.deliveredAt = new Date().toISOString();
          entry.lastError = null;
          return;
        }
        entry.lastError = `HTTP ${res.status}`;
        // 4xx other than 408/429 will not get better by retrying (bad signature, bad payload).
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
      } catch (err) {
        entry.lastError = err instanceof Error ? err.message : String(err);
      }
      if (attempt < max) await new Promise((r) => setTimeout(r, (this.opts.backoffMs ?? 500) * 2 ** (attempt - 1)));
    }
    entry.status = "failed";
    this.opts.log?.("webhook delivery failed", { id: entry.id, kind: entry.kind, error: entry.lastError });
  }
}

/** Test sink: records bodies, never does I/O. */
export class RecordingSink implements WebhookSink {
  readonly sent: { kind: WebhookKind; body: unknown }[] = [];
  send(kind: WebhookKind, body: unknown): OutboxEntry {
    this.sent.push({ kind, body });
    return {
      id: randomUUID(),
      kind,
      url: `recording://${kind}`,
      body,
      createdAt: new Date().toISOString(),
      attempts: 0,
      status: "delivered",
      lastStatusCode: null,
      lastError: null,
      deliveredAt: null,
    };
  }
}
