import { createHmac, randomBytes } from "node:crypto";

import { DEMO_TOKEN_HEADER, MOCK_WEBHOOK_SIGNATURE_HEADER, MOCK_WEBHOOK_TIMESTAMP_HEADER } from "@kassa/shared";

import type { FetchLike } from "../clock.ts";

/*
 * Server-side API client for the Demo Stage (/mock/stage). The stage pages never see a secret: the demo admin
 * token and the Shortcut device token live only here, in mock-world's memory. Every call goes to an existing
 * API route, authenticated the way that route expects:
 *   - demo admin routes (/api/demo/...): header x-kassa-demo-token
 *   - Shortcut capture (/api/capture/shortcut): `Authorization: Bearer <device token>` (I13); the token is minted
 *     for the demo user by POST /api/demo/stage/shortcut-token and re-minted once if a demo reset revoked it.
 *   - forged bank webhook: deliberately NOT signed with the shared secret (the point is that the API rejects it).
 */

export interface ApiResult {
  status: number;
  body: unknown;
}

export class StageApiError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class StageApi {
  private shortcutToken: string | null = null;

  constructor(
    private readonly opts: {
      apiUrl: string;
      demoToken: string | null;
      fetch?: FetchLike;
      timeoutMs?: number;
    },
  ) {}

  /** Whether a demo admin token is configured (the value itself is never exposed). */
  get hasDemoToken(): boolean {
    return this.opts.demoToken !== null;
  }

  /** Forget the cached device token (after a demo reset the API's devices table is re-seeded). */
  reset(): void {
    this.shortcutToken = null;
  }

  private async call(method: "GET" | "POST", path: string, body: unknown, headers: Record<string, string>): Promise<ApiResult> {
    const f = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.opts.apiUrl}${path}`, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new StageApiError(`Kassa API unreachable (${err instanceof Error ? err.message : String(err)})`);
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 200) };
    }
    return { status: res.status, body: parsed };
  }

  private demoHeaders(): Record<string, string> {
    return this.opts.demoToken ? { [DEMO_TOKEN_HEADER]: this.opts.demoToken } : {};
  }

  /** POST /api/demo/<path> with the demo admin token. */
  demo(path: string, body: unknown = {}): Promise<ApiResult> {
    return this.call("POST", `/api/demo/${path}`, body, this.demoHeaders());
  }

  private async mintShortcutToken(): Promise<string> {
    const r = await this.demo("stage/shortcut-token");
    const token = (r.body as { token?: unknown } | null)?.token;
    if (r.status !== 201 || typeof token !== "string") {
      throw new StageApiError(`Could not create the demo device token (HTTP ${r.status} ${problemCode(r.body) ?? ""})`.trim());
    }
    this.shortcutToken = token;
    return token;
  }

  /** POST /api/capture/shortcut as the demo user's phone (device bearer token). */
  async shortcutCapture(payload: Record<string, unknown>): Promise<ApiResult> {
    const send = (token: string) => this.call("POST", "/api/capture/shortcut", payload, { authorization: `Bearer ${token}` });
    let r = await send(this.shortcutToken ?? (await this.mintShortcutToken()));
    if (r.status === 401) {
      // Revoked or wiped by a demo reset: mint a fresh one, once.
      r = await send(await this.mintShortcutToken());
    }
    return r;
  }

  /**
   * A fake bank's "SENT" message (S2/I13 demo). Two attempts: no signature headers at all, and an HMAC made with a
   * key the attacker invented. Neither knows the shared secret, so the API must answer 401 to both.
   */
  async forgedBankWebhook(body: unknown, nowSeconds: number): Promise<{ unsigned: ApiResult; wrongKey: ApiResult }> {
    const raw = JSON.stringify(body);
    const f = this.opts.fetch ?? fetch;
    const post = async (headers: Record<string, string>): Promise<ApiResult> => {
      try {
        const res = await f(`${this.opts.apiUrl}/api/webhooks/mock/bank`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: raw,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
        });
        const text = await res.text();
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = null;
        }
        return { status: res.status, body: parsed };
      } catch (err) {
        throw new StageApiError(`Kassa API unreachable (${err instanceof Error ? err.message : String(err)})`);
      }
    };
    const attackerKey = randomBytes(32);
    const ts = String(nowSeconds);
    const sig = createHmac("sha256", attackerKey).update(`${ts}.${raw}`).digest("hex");
    const unsigned = await post({});
    const wrongKey = await post({ [MOCK_WEBHOOK_TIMESTAMP_HEADER]: ts, [MOCK_WEBHOOK_SIGNATURE_HEADER]: sig });
    return { unsigned, wrongKey };
  }
}

/** `code` of an RFC 9457 problem or ApiError body, if any. */
export function problemCode(body: unknown): string | null {
  if (body && typeof body === "object" && "code" in body && typeof (body as { code: unknown }).code === "string") {
    return (body as { code: string }).code;
  }
  return null;
}
