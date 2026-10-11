import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  MOCK_WEBHOOK_SIGNATURE_HEADER,
  MOCK_WEBHOOK_TIMESTAMP_HEADER,
  mockWebhookHeaders,
  signMockWebhook,
  verifyMockWebhook,
} from "@kassa/shared";

import { ManualClock } from "../src/clock.ts";
import { WebhookClient } from "../src/webhooks.ts";

const SECRET = "s3cret";
const T0 = Date.parse("2026-10-27T09:00:00Z");
const TS = T0 / 1000;

function refHmac(key: string, message: string): string {
  return createHmac("sha256", key).update(message).digest("hex");
}

describe("signMockWebhook", () => {
  it("equals HMAC-SHA256 over `${ts}.${body}`", () => {
    const body = '{"a":1}';
    expect(signMockWebhook(SECRET, TS, body)).toBe(refHmac(SECRET, `${TS}.${body}`));
    expect(signMockWebhook("another-secret", 0, "")).toBe(refHmac("another-secret", "0."));
  });

  it("signs UTF-8 bodies byte-for-byte (tenge and accented characters)", () => {
    const body = '{"amount":"500 ₸","name":"Café é"}';
    expect(signMockWebhook(SECRET, TS, body)).toBe(refHmac(SECRET, `${TS}.${body}`));
  });

  it("matches the RFC 4231 test case 2 HMAC-SHA256 vector when the format is `ts.body` with a known prefix", () => {
    // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?".
    const vector = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
    expect(refHmac("Jefe", "what do ya want for nothing?")).toBe(vector);
    // Our signer signs `${ts}.${body}`: with ts 0 and body X it must equal HMAC over "0." + X.
    expect(signMockWebhook("Jefe", 0, "what do ya want for nothing?")).toBe(
      refHmac("Jefe", "0.what do ya want for nothing?"),
    );
  });

  it("rejects an empty secret and a negative or non-integer timestamp", () => {
    expect(() => signMockWebhook("", TS, "{}")).toThrow();
    expect(() => signMockWebhook(SECRET, -1, "{}")).toThrow(RangeError);
    expect(() => signMockWebhook(SECRET, 1.5, "{}")).toThrow(RangeError);
  });
});

describe("mockWebhookHeaders", () => {
  it("uses the documented header names and floors the timestamp", () => {
    const h = mockWebhookHeaders(SECRET, "{}", TS + 0.9);
    expect(h[MOCK_WEBHOOK_TIMESTAMP_HEADER]).toBe(String(TS));
    expect(h[MOCK_WEBHOOK_SIGNATURE_HEADER]).toBe(signMockWebhook(SECRET, TS, "{}"));
  });
});

describe("verifyMockWebhook", () => {
  const body = '{"event":"x"}';
  const sig = signMockWebhook(SECRET, TS, body);

  it("accepts a valid signature inside the replay window", () => {
    expect(verifyMockWebhook(SECRET, String(TS), sig, body, TS)).toEqual({ ok: true });
    expect(verifyMockWebhook(SECRET, String(TS), sig, body, TS + 300)).toEqual({ ok: true });
    expect(verifyMockWebhook(SECRET, String(TS), sig, body, TS - 300)).toEqual({ ok: true });
  });

  it("reports WEBHOOK_REPLAY_WINDOW when the clock is 301 s after the timestamp", () => {
    expect(verifyMockWebhook(SECRET, String(TS), sig, body, TS + 301)).toEqual({ ok: false, code: "WEBHOOK_REPLAY_WINDOW" });
  });

  it("reports WEBHOOK_SIGNATURE_INVALID for a tampered body", () => {
    expect(verifyMockWebhook(SECRET, String(TS), sig, body.replace("x", "y"), TS)).toEqual({
      ok: false,
      code: "WEBHOOK_SIGNATURE_INVALID",
    });
  });

  it("reports WEBHOOK_SIGNATURE_INVALID for a wrong secret", () => {
    expect(verifyMockWebhook("wrong", String(TS), sig, body, TS)).toEqual({ ok: false, code: "WEBHOOK_SIGNATURE_INVALID" });
  });

  it("reports WEBHOOK_SIGNATURE_INVALID for missing headers", () => {
    expect(verifyMockWebhook(SECRET, undefined, sig, body, TS)).toEqual({ ok: false, code: "WEBHOOK_SIGNATURE_INVALID" });
    expect(verifyMockWebhook(SECRET, String(TS), undefined, body, TS)).toEqual({ ok: false, code: "WEBHOOK_SIGNATURE_INVALID" });
    expect(verifyMockWebhook(SECRET, "", sig, body, TS)).toEqual({ ok: false, code: "WEBHOOK_SIGNATURE_INVALID" });
  });

  it("reports WEBHOOK_SIGNATURE_INVALID for a non-numeric timestamp", () => {
    expect(verifyMockWebhook(SECRET, "2026-10-27T09:00:00Z", sig, body, TS)).toEqual({
      ok: false,
      code: "WEBHOOK_SIGNATURE_INVALID",
    });
    expect(verifyMockWebhook(SECRET, `${TS}abc`, sig, body, TS)).toEqual({ ok: false, code: "WEBHOOK_SIGNATURE_INVALID" });
  });
});

describe("WebhookClient", () => {
  const API = "http://api.test";
  const ok = () => new Response("{}", { status: 200 });

  function makeClient(fetchFn: ReturnType<typeof vi.fn>) {
    const clock = new ManualClock(T0);
    const client = new WebhookClient({
      apiUrl: API,
      secret: SECRET,
      clock,
      fetch: fetchFn as unknown as (input: string, init?: RequestInit) => Promise<Response>,
      backoffMs: 1,
    });
    return { client, clock };
  }

  it("POSTs a signed body that the receiver can verify, and marks the entry delivered", async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => ok());
    const { client } = makeClient(fetchFn);

    const entry = client.send("bank", { a: 1 });
    await client.idle();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/api/webhooks/mock/bank");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    const tsHeader = headers["x-kassa-timestamp"]!;
    const sigHeader = headers["x-kassa-signature"]!;
    expect(tsHeader).toBe(String(T0 / 1000));
    expect(verifyMockWebhook(SECRET, tsHeader, sigHeader, init.body as string, T0 / 1000)).toEqual({ ok: true });

    expect(entry.status).toBe("delivered");
    expect(entry.attempts).toBe(1);
  });

  it("retries on 500 and delivers on the third attempt", async () => {
    const fetchFn = vi
      .fn(async (_url: string, _init?: RequestInit) => new Response("", { status: 500 }))
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const { client } = makeClient(fetchFn);

    const entry = client.send("qr", { b: 2 });
    await client.idle();

    expect(entry.attempts).toBe(3);
    expect(entry.status).toBe("delivered");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 401 and marks the entry failed after one attempt", async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response("", { status: 401 }));
    const { client } = makeClient(fetchFn);

    const entry = client.send("pos", { c: 3 });
    await client.idle();

    expect(entry.attempts).toBe(1);
    expect(entry.status).toBe("failed");
    expect(entry.lastStatusCode).toBe(401);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
