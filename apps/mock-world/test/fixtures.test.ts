import { describe, expect, it } from "vitest";

import { isValidIban, isValidRfReference, MandateCore } from "@kassa/shared";

import {
  ACCOUNTS,
  IDS,
  payees,
  seed,
  TUITION_REFERENCE,
  transactions,
  cards,
  budgets,
  balances,
  obligations,
  mandates,
  profile,
  user,
  liWei,
  LI_WEI_IDS,
  LI_WEI_TUITION_REFERENCE,
} from "../../../fixtures/seed-data.ts";
import { seedId, uuidV5 } from "../../../fixtures/uuid.ts";

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEED_NOW = Date.parse("2026-10-27T09:00:00.000Z");
const DAY_MS = 86_400_000;

/** Independent ISO 13616 / MOD 97-10 check: letters A=10..Z=35, the whole number mod 97 must be 1. */
function mod97IsOne(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let numeric = "";
  for (const ch of rearranged) {
    numeric += ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
  }
  return BigInt(numeric) % 97n === 1n;
}

describe("account numbers", () => {
  it("every IBAN payee passes the shared validator and an independent MOD 97 check", () => {
    const ibanPayees = payees.filter((p) => p.accountScheme === "IBAN");
    expect(ibanPayees.length).toBeGreaterThan(0);
    for (const p of ibanPayees) {
      expect(isValidIban(p.account), p.name).toBe(true);
      expect(mod97IsOne(p.account), p.name).toBe(true);
    }
  });

  it("every fictitious account in ACCOUNTS is a valid IBAN", () => {
    for (const [name, iban] of Object.entries(ACCOUNTS)) {
      expect(isValidIban(iban), name).toBe(true);
      expect(mod97IsOne(iban), name).toBe(true);
    }
  });

  it("the tuition reference is a valid ISO 11649 RF reference", () => {
    expect(isValidRfReference(TUITION_REFERENCE)).toBe(true);
  });
});

describe("stable ids", () => {
  it("literal ids equal seedId(name)", () => {
    expect(IDS.user).toBe(seedId("user/dana"));
    expect(IDS.payees.landlord).toBe(seedId("payee/landlord"));
    expect(IDS.payees.university).toBe(seedId("payee/university"));
    expect(IDS.payees.insurer).toBe(seedId("payee/insurer"));
    expect(IDS.payees.pizzaShop).toBe(seedId("payee/pizza-shop"));
    expect(IDS.cards.kzt).toBe(seedId("card/kzt"));
    expect(IDS.cards.usd).toBe(seedId("card/usd"));
    expect(IDS.cards.local).toBe(seedId("card/local"));
    expect(IDS.obligations.rent).toBe(seedId("obligation/rent"));
    expect(IDS.obligations.tuition).toBe(seedId("obligation/tuition"));
    expect(IDS.obligations.insurance).toBe(seedId("obligation/insurance"));
    expect(IDS.mandates.rent).toBe(seedId("mandate/rent"));
    expect(IDS.budgets.groceries).toBe(seedId("budget/groceries"));
    expect(IDS.budgets.eatingOut).toBe(seedId("budget/eating_out"));
    expect(IDS.budgets.transport).toBe(seedId("budget/transport"));
  });

  it("uuidV5 reproduces the RFC 9562 DNS-namespace example", () => {
    expect(uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });

  it("every id is a UUIDv5 and all ids are unique", () => {
    const ids = [
      user.id,
      ...payees.map((p) => p.id),
      ...cards.map((c) => c.id),
      ...obligations.map((o) => o.id),
      ...budgets.map((b) => b.id),
      ...transactions.map((t) => t.id),
      ...mandates.map((m) => m.core.mandateId),
    ];
    for (const id of ids) expect(id).toMatch(UUID_V5);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("spec section 18 story values", () => {
  it("user and profile settings", () => {
    expect(user.homeCurrency).toBe("KZT");
    expect(user.region).toBe("EU");
    expect(user.preset).toBe("SMART");
    expect(user.moneyMode).toBe("CAPPED_WALLET");
    expect(profile.incomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "Parents", currency: "KZT", amountMinor: 60_000_000, dayOfMonth: 25 }),
        expect.objectContaining({ source: "Scholarship", currency: "USD", amountMinor: 40_000, dayOfMonth: 1 }),
      ]),
    );
  });

  it("starting balances", () => {
    const byCurrency = Object.fromEntries(balances.map((b) => [b.currency, b.amountMinor]));
    expect(byCurrency).toEqual({ KZT: 90_000_000, USD: 45_000, HUF: 12_000_000, EUR: 30_000 });
  });

  it("rent and tuition obligations", () => {
    const rent = obligations.find((o) => o.id === IDS.obligations.rent)!;
    expect(rent).toMatchObject({ amountMinor: 18_000_000, currency: "HUF", dueDate: "2026-11-01", recurrence: "MONTHLY" });
    const tuition = obligations.find((o) => o.id === IDS.obligations.tuition)!;
    expect(tuition).toMatchObject({ amountMinor: 240_000, currency: "EUR", dueDate: "2026-10-31" });
    expect(tuition.reference).not.toBeNull();
  });

  it("budgets", () => {
    const limits = Object.fromEntries(budgets.map((b) => [b.category, b.limitHomeMinor]));
    expect(limits).toEqual({ groceries: 9_000_000, eating_out: 6_000_000, transport: 2_000_000 });
  });

  it("the rent mandate core parses with the shared schema and has the spec limits", () => {
    const core = mandates[0]!.core;
    expect(MandateCore.parse(core)).toEqual(core);
    expect(core.maxPerPeriodMinor).toBe(20_000_000);
    expect(core.currency).toBe("HUF");
  });
});

describe("seeded transactions", () => {
  it("span at most 31 days and end at or before SEED_NOW", () => {
    const times = transactions.map((t) => Date.parse(t.occurredAt));
    const span = Math.max(...times) - Math.min(...times);
    expect(span).toBeLessThanOrEqual(31 * DAY_MS);
    expect(Math.max(...times)).toBeLessThanOrEqual(SEED_NOW);
  });

  it("has exactly two pending card charges, both in a currency other than the card's billing currency", () => {
    const pending = transactions.filter((t) => t.status === "PENDING");
    expect(pending).toHaveLength(2);
    for (const t of pending) {
      const card = cards.find((c) => c.id === t.cardId);
      expect(card, t.merchantRaw).toBeDefined();
      expect(t.currency).not.toBe(card!.billingCurrency);
      expect(t.settledAmountMinor).toBeNull();
    }
  });

  it("every amount is a safe positive integer and at least five sources are represented", () => {
    for (const t of transactions) {
      expect(Number.isSafeInteger(t.amountMinor), t.id).toBe(true);
      expect(t.amountMinor, t.id).toBeGreaterThan(0);
    }
    expect(new Set(transactions.map((t) => t.source)).size).toBeGreaterThanOrEqual(5);
  });
});

describe("default export", () => {
  it("exposes the seed bundle with the story constants", () => {
    expect(seed.seedNow).toBe("2026-10-27T09:00:00.000Z");
    expect(seed.homeCurrency).toBe("KZT");
    expect(seed.mockBankProfileId).toBe(16_000_001);
  });
});

describe("second persona Li Wei (D-CN3)", () => {
  const li = liWei;
  const liIds = [
    li.user.id,
    ...li.payees.map((p) => p.id),
    ...li.cards.map((c) => c.id),
    ...li.obligations.map((o) => o.id),
    ...li.budgets.map((b) => b.id),
    ...li.transactions.map((t) => t.id),
  ];

  it("every LI_WEI_IDS literal equals seedId of its name", () => {
    expect(LI_WEI_IDS.user).toBe(seedId("user/li-wei"));
    expect(LI_WEI_IDS.payees.landlord).toBe(seedId("li-wei/payee/landlord"));
    expect(LI_WEI_IDS.payees.university).toBe(seedId("li-wei/payee/university"));
    expect(LI_WEI_IDS.cards.cny).toBe(seedId("li-wei/card/cny"));
    expect(LI_WEI_IDS.cards.local).toBe(seedId("li-wei/card/local"));
    expect(LI_WEI_IDS.obligations.rent).toBe(seedId("li-wei/obligation/rent"));
    expect(LI_WEI_IDS.obligations.tuition).toBe(seedId("li-wei/obligation/tuition"));
    expect(LI_WEI_IDS.budgets.groceries).toBe(seedId("li-wei/budget/groceries"));
    expect(LI_WEI_IDS.budgets.eatingOut).toBe(seedId("li-wei/budget/eating_out"));
    expect(LI_WEI_IDS.budgets.transport).toBe(seedId("li-wei/budget/transport"));
  });

  it("Dana's dormOffice, cnShop and dormFee literal ids equal seedId of their names", () => {
    expect(IDS.payees.dormOffice).toBe(seedId("payee/dorm-office-shanghai"));
    expect(IDS.payees.cnShop).toBe(seedId("payee/buy-everything-shop-china"));
    expect(IDS.obligations.dormFee).toBe(seedId("obligation/dorm-fee"));
  });

  it("every Li id is a UUIDv5 and Dana's and Li's ids together are unique", () => {
    for (const id of liIds) expect(id).toMatch(UUID_V5);
    const danaIds = [
      user.id,
      ...payees.map((p) => p.id),
      ...cards.map((c) => c.id),
      ...obligations.map((o) => o.id),
      ...budgets.map((b) => b.id),
      ...transactions.map((t) => t.id),
      ...mandates.map((m) => m.core.mandateId),
    ];
    const all = [...danaIds, ...liIds];
    expect(new Set(all).size).toBe(all.length);
  });

  it("Li's IBAN payees pass the shared validator and the MOD 97 check", () => {
    const ibanPayees = li.payees.filter((p) => p.accountScheme === "IBAN");
    expect(ibanPayees.length).toBeGreaterThan(0);
    for (const p of ibanPayees) {
      expect(isValidIban(p.account), p.name).toBe(true);
      expect(mod97IsOne(p.account), p.name).toBe(true);
    }
  });

  it("the tuition reference is a valid ISO 11649 RF reference", () => {
    expect(isValidRfReference(LI_WEI_TUITION_REFERENCE)).toBe(true);
  });

  it("user, currencies and balances", () => {
    expect(li.user).toMatchObject({ homeCurrency: "CNY", region: "EU", preset: "SMART", moneyMode: "CAPPED_WALLET" });
    const byCurrency = Object.fromEntries(li.balances.map((b) => [b.currency, b.amountMinor]));
    expect(byCurrency).toEqual({ CNY: 6_000_000, EUR: 45_000, HUF: 9_500_000 });
  });

  it("every money field is a safe integer", () => {
    for (const t of li.transactions) {
      expect(Number.isSafeInteger(t.amountMinor), t.id).toBe(true);
      expect(Number.isSafeInteger(t.homeAmountMinor), t.id).toBe(true);
      if (t.settledAmountMinor !== null) expect(Number.isSafeInteger(t.settledAmountMinor), t.id).toBe(true);
    }
    for (const o of li.obligations) expect(Number.isSafeInteger(o.amountMinor), o.id).toBe(true);
    for (const b of li.budgets) expect(Number.isSafeInteger(b.limitHomeMinor), b.id).toBe(true);
    for (const b of li.balances) expect(Number.isSafeInteger(b.amountMinor), b.currency).toBe(true);
  });

  it("every Li transaction is SETTLED and dated within 31 days before SEED_NOW", () => {
    for (const t of li.transactions) {
      expect(t.status, t.id).toBe("SETTLED");
      const at = Date.parse(t.occurredAt);
      expect(at, t.id).toBeLessThanOrEqual(SEED_NOW);
      expect(at, t.id).toBeGreaterThanOrEqual(SEED_NOW - 31 * DAY_MS);
    }
  });

  it("seed.personas is exactly Li Wei", () => {
    expect(seed.personas).toEqual([liWei]);
  });
});
