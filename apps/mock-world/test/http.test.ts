import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildMockWorld } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { ManualClock } from "../src/clock.ts";
import { StaticRates } from "../src/bank/rates.ts";
import type { Issuer } from "../src/shop/issuer.ts";
import { RecordingSink } from "../src/webhooks.ts";

const USER_ID = "c83d27e3-4e03-570f-8fea-87db32399c12";
const PROFILE = "16000001";

const config = loadConfig({
  API_URL: "http://api.test",
  MOCK_PUBLIC_URL: "http://mock.test",
  MOCK_HMAC_SECRET: "s3cret",
  NODE_ENV: "test",
} as NodeJS.ProcessEnv);

const authorize = vi
  .fn()
  .mockResolvedValueOnce({ approved: true, provider: "fake", authorizationId: "auth_1", reasonCode: null, issuerStatus: 200 })
  .mockResolvedValueOnce({
    approved: false,
    provider: "fake",
    authorizationId: "auth_2",
    reasonCode: "CARD_ALREADY_USED",
    issuerStatus: 200,
  });
const fakeIssuer: Issuer = { provider: "fake" as const, authorize };

let app: FastifyInstance;
let sink: RecordingSink;

beforeAll(async () => {
  sink = new RecordingSink();
  const world = await buildMockWorld({
    config,
    clock: new ManualClock(Date.parse("2026-10-27T09:00:00Z")),
    webhooks: sink,
    rates: new StaticRates(),
    issuer: fakeIssuer,
    logger: false,
    startTicker: false,
  });
  app = world.app;
});

afterAll(async () => {
  await app.close();
});

function jsonOf(res: { body: string }): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

describe("health and pizza shop", () => {
  it("GET /mock/health reports the service as simulated", async () => {
    const res = await app.inject({ method: "GET", url: "/mock/health" });
    expect(res.statusCode).toBe(200);
    expect(jsonOf(res).simulated).toBe(true);
  });

  it("GET /mock/shop/pizza/menu lists six items in HUF", async () => {
    const res = await app.inject({ method: "GET", url: "/mock/shop/pizza/menu" });
    expect(res.statusCode).toBe(200);
    const body = jsonOf(res);
    expect(body.items).toHaveLength(6);
    expect(body.currency).toBe("HUF");
  });

  it("checkout is approved first, then declined with CARD_ALREADY_USED for the same card", async () => {
    const payload = { cardId: "card_x", items: [{ sku: "PZ-MARG", quantity: 2 }] };

    const first = await app.inject({ method: "POST", url: "/mock/shop/pizza/checkout", payload });
    expect(first.statusCode).toBe(200);
    expect(jsonOf(first)).toMatchObject({ status: "approved", amountMinor: 598_000 });

    const second = await app.inject({ method: "POST", url: "/mock/shop/pizza/checkout", payload });
    expect(second.statusCode).toBe(402);
    expect(jsonOf(second)).toMatchObject({ status: "declined", reasonCode: "CARD_ALREADY_USED" });

    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        amountMinor: 598_000,
        currency: "HUF",
        merchant: expect.objectContaining({ name: "Pizza Shop in Budapest" }),
      }),
    );
  });
});

describe("pizza stores (Business M0)", () => {
  it("bud and pizza are the same Budapest store; sha is Shanghai in CNY", async () => {
    const bud = jsonOf(await app.inject({ method: "GET", url: "/mock/shop/bud/menu" }));
    const pizza = jsonOf(await app.inject({ method: "GET", url: "/mock/shop/pizza/menu" }));
    expect(bud).toEqual(pizza);
    const sha = await app.inject({ method: "GET", url: "/mock/shop/sha/menu" });
    expect(sha.statusCode).toBe(200);
    expect(jsonOf(sha)).toMatchObject({ currency: "CNY", merchant: { storeId: "sha", name: "Pizza Shop in Shanghai", timezone: "Asia/Shanghai" } });
    expect((jsonOf(sha).items as unknown[]).length).toBe(6);
    expect((await app.inject({ method: "GET", url: "/mock/shop/nope/menu" })).statusCode).toBe(404);
  });

  it("a Shanghai checkout is priced in CNY at the Shanghai shop", async () => {
    authorize.mockResolvedValueOnce({ approved: true, provider: "fake", authorizationId: "auth_sha", reasonCode: null, issuerStatus: 200 });
    const res = await app.inject({ method: "POST", url: "/mock/shop/sha/checkout", payload: { cardId: "card_sha", items: [{ sku: "PZ-MARG", quantity: 2 }] } });
    expect(res.statusCode).toBe(200);
    expect(jsonOf(res)).toMatchObject({ status: "approved", amountMinor: 13_600, currency: "CNY", merchant: "Pizza Shop in Shanghai" });
    const charges = jsonOf(await app.inject({ method: "GET", url: "/mock/shop/sha/charges" })).charges as { storeId: string }[];
    expect(charges.length).toBeGreaterThan(0);
    expect(charges.every((c) => c.storeId === "sha")).toBe(true);
    expect(authorize).toHaveBeenLastCalledWith(expect.objectContaining({ currency: "CNY", merchant: expect.objectContaining({ name: "Pizza Shop in Shanghai", country: "CN" }) }));
  });

  it("the Shanghai suppliers' catalogs and price lists are served", async () => {
    for (const id of ["c", "d"]) {
      const cat = await app.inject({ method: "GET", url: `/mock/suppliers/${id}/catalog` });
      expect(cat.statusCode, id).toBe(200);
      expect(jsonOf(cat)).toMatchObject({ currency: "CNY", supplier: { iban: null } });
      const pdf = await app.inject({ method: "GET", url: `/mock/suppliers/${id}/price-list.pdf` });
      expect(pdf.statusCode, id).toBe(200);
    }
  });
});

describe("HTML pages", () => {
  it("shows the simulated banner on the index and the pizza page", async () => {
    for (const url of ["/mock", "/mock/shop/pizza", "/mock/shop/bud", "/mock/shop/sha"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body.toLowerCase(), url).toContain("simulated");
    }
  });

  it("shows the QR wallet page for a created payment", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/mock/qr/payments",
      payload: { merchantId: "dorm-office", amountMinor: 150_000, currency: "CNY", reference: "ROOM-12" },
    });
    expect(created.statusCode).toBe(201);
    const paymentId = jsonOf(created).paymentId as string;

    const res = await app.inject({ method: "GET", url: `/mock/qr/${paymentId}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("QR Wallet (simulated)");
  });
});

describe("payee invoices and supplier documents", () => {
  it("serves the tuition invoice as a PDF", async () => {
    const res = await app.inject({ method: "GET", url: "/mock/payees/university/invoice.pdf" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("serves a different PDF for the swapped-account variant", async () => {
    const normal = await app.inject({ method: "GET", url: "/mock/payees/university/invoice.pdf" });
    const swapped = await app.inject({ method: "GET", url: "/mock/payees/university/invoice.pdf?variant=swapped-account" });
    expect(swapped.statusCode).toBe(200);
    expect(swapped.rawPayload.equals(normal.rawPayload)).toBe(false);
  });

  it("has no swapped variant for the landlord and no invoice for an unknown payee", async () => {
    const landlord = await app.inject({ method: "GET", url: "/mock/payees/landlord/invoice.pdf?variant=swapped-account" });
    expect(landlord.statusCode).toBe(404);
    const nobody = await app.inject({ method: "GET", url: "/mock/payees/nobody/invoice.pdf" });
    expect(nobody.statusCode).toBe(404);
  });

  it("puts the hidden instruction in supplier B's catalog notes but not supplier A's", async () => {
    const b = await app.inject({ method: "GET", url: "/mock/suppliers/b/catalog" });
    expect(jsonOf(b).notes).toContain("invoice #8812");
    const a = await app.inject({ method: "GET", url: "/mock/suppliers/a/catalog" });
    expect(jsonOf(a).notes).not.toContain("invoice #8812");
  });
});

describe("inbox", () => {
  it("contains the lookalike account-change email with the attacker IBAN and no ground-truth tag", async () => {
    const res = await app.inject({ method: "GET", url: "/mock/inbox" });
    expect(res.statusCode).toBe(200);
    const emails = (res.json() as { emails: { subject: string; body: string }[] }).emails;
    const attack = emails.find((e) => e.subject.includes("bank account has changed"));
    expect(attack).toBeDefined();
    expect(attack!.body).toContain("HU03 1620 0216 9011 7442 0000 0000");
    for (const e of emails) expect(Object.keys(e)).not.toContain("tag");
  });
});

describe("Wise-shaped bank flow", () => {
  it("quotes, creates a recipient and a transfer, funds it and reads the state back", async () => {
    const quote = await app.inject({
      method: "POST",
      url: `/mock/v3/profiles/${USER_ID}/quotes`,
      payload: { sourceCurrency: "EUR", targetCurrency: "EUR", targetAmountMinor: 9600 },
    });
    expect(quote.statusCode).toBe(200);
    const quoteId = jsonOf(quote).id as string;

    const account = await app.inject({
      method: "POST",
      url: "/mock/v1/accounts",
      payload: {
        currency: "EUR",
        type: "iban",
        profile: USER_ID,
        accountHolderName: "X",
        details: { legalType: "BUSINESS", iban: "HU92104051760049812600000008" },
      },
    });
    expect(account.statusCode).toBe(200);
    const targetAccount = jsonOf(account).id as number;

    const transfer = await app.inject({
      method: "POST",
      url: "/mock/v1/transfers",
      payload: { targetAccount, quoteUuid: quoteId, customerTransactionId: randomUUID(), details: { reference: "r" } },
    });
    expect(transfer.statusCode).toBe(200);
    const t = jsonOf(transfer);
    expect(t.status).toBe("incoming_payment_waiting");

    const fund = await app.inject({
      method: "POST",
      url: `/mock/v3/profiles/${PROFILE}/transfers/${t.id as number}/payments`,
      payload: { type: "BALANCE" },
    });
    expect(fund.statusCode).toBe(200);
    expect(jsonOf(fund).status).toBe("COMPLETED");

    const read = await app.inject({ method: "GET", url: `/mock/v1/transfers/${t.id as number}` });
    expect(jsonOf(read).status).toBe("processing");
  });

  it("rejects an invalid IBAN with 422 NOT_VALID in Wise's errors shape", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mock/v1/accounts",
      payload: {
        currency: "EUR",
        type: "iban",
        profile: USER_ID,
        accountHolderName: "X",
        details: { legalType: "BUSINESS", iban: "HU92104051760049812600000009" },
      },
    });
    expect(res.statusCode).toBe(422);
    expect((jsonOf(res).errors as { code: string }[])[0]!.code).toBe("NOT_VALID");
  });

  it("returns 404 for a quote on an unknown profile", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mock/v3/profiles/999/quotes",
      payload: { sourceCurrency: "EUR", targetCurrency: "EUR", targetAmountMinor: 9600 },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("events and demo reset", () => {
  it("credits a remittance and emits a remittance webhook", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mock/remittance/incoming",
      payload: { amount: "400000", currency: "KZT" },
    });
    expect(res.statusCode).toBe(202);
    expect((jsonOf(res).event as { amountMinor: number }).amountMinor).toBe(40_000_000);

    const balances = await app.inject({ method: "GET", url: `/mock/v4/profiles/${PROFILE}/balances` });
    const kzt = (balances.json() as { currency: string; amount: { valueMinor: number } }[]).find((b) => b.currency === "KZT");
    expect(kzt!.amount.valueMinor).toBe(90_000_000 + 40_000_000);

    expect(sink.sent.some((s) => s.kind === "remittance")).toBe(true);
  });

  it("emits a pos webhook with the requested stock level", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mock/pos/emit",
      payload: { sku: "DOUGH-250G-40", level: 3 },
    });
    expect(res.statusCode).toBe(202);
    const pos = sink.sent.filter((s) => s.kind === "pos");
    expect(pos).toHaveLength(1);
    expect((pos[0]!.body as { level: number }).level).toBe(3);
  });

  it("POST /mock/reset restores the KZT balance", async () => {
    const res = await app.inject({ method: "POST", url: "/mock/reset" });
    expect(res.statusCode).toBe(200);

    const balances = await app.inject({ method: "GET", url: `/mock/v4/profiles/${PROFILE}/balances` });
    const kzt = (balances.json() as { currency: string; amount: { valueMinor: number } }[]).find((b) => b.currency === "KZT");
    expect(kzt!.amount.valueMinor).toBe(90_000_000);
  });
});
