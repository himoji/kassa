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
  BUSINESS_IDS,
  liWeiCn,
  MENU_SKUS,
  pizzeriaBud,
  pizzeriaSha,
  SHA_BOX_SHORTAGE,
  seedForecastShortage,
  SUPPLIER_PACKS,
} from "../../../fixtures/seed-data.ts";
import { PIZZA_MENUS, PIZZA_STORES, QR_MERCHANTS, SUPPLIERS } from "../src/world/data.ts";
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

  it("seed.personas: Li Wei, Li Wei in Shanghai and the two pizzerias", () => {
    expect(seed.personas).toEqual([liWei, liWeiCn, pizzeriaBud, pizzeriaSha]);
    expect(new Set(seed.personas.map((p) => p.persona)).size).toBe(seed.personas.length);
    expect(new Set(seed.personas.map((p) => p.mockBankProfileId)).size).toBe(seed.personas.length);
  });
});

describe("Kassa Business personas (M0)", () => {
  const shops = [pizzeriaBud, pizzeriaSha] as const;

  it("every BUSINESS_IDS literal equals seedId of its name", () => {
    expect(BUSINESS_IDS.bud.user).toBe(seedId("user/pizzeria-bud"));
    expect(BUSINESS_IDS.bud.merchant).toBe(seedId("pizzeria-bud/merchant"));
    expect(BUSINESS_IDS.bud.payees.supplierA).toBe(seedId("pizzeria-bud/payee/supplier-a"));
    expect(BUSINESS_IDS.bud.payees.supplierB).toBe(seedId("pizzeria-bud/payee/supplier-b"));
    expect(BUSINESS_IDS.sha.user).toBe(seedId("user/pizzeria-sha"));
    expect(BUSINESS_IDS.sha.merchant).toBe(seedId("pizzeria-sha/merchant"));
    expect(BUSINESS_IDS.sha.payees.supplierC).toBe(seedId("pizzeria-sha/payee/supplier-c"));
    expect(BUSINESS_IDS.sha.payees.supplierD).toBe(seedId("pizzeria-sha/payee/supplier-d"));
    expect(BUSINESS_IDS.liWeiCn.user).toBe(seedId("user/li-wei-cn"));
    expect(BUSINESS_IDS.liWeiCn.payees.pizzaShopSh).toBe(seedId("li-wei-cn/payee/pizza-shop-sh"));
    expect(BUSINESS_IDS.liWeiCn.budgets.eatingOut).toBe(seedId("li-wei-cn/budget/eating_out"));
  });

  it("all persona ids (and stock movement / supplier item ids) are unique UUIDv5s", () => {
    const ids = seed.personas.flatMap((p) => [p.user.id, ...p.payees.map((x) => x.id), ...p.budgets.map((b) => b.id), ...p.transactions.map((t) => t.id)]);
    const bizIds = shops.flatMap((p) => [p.business.merchant.id, ...p.business.stockMovements.map((m) => m.id), ...p.business.supplierItems.map((x) => x.id)]);
    const all = [user.id, ...payees.map((p) => p.id), ...ids, ...bizIds];
    for (const id of all) expect(id).toMatch(UUID_V5);
    expect(new Set(all).size).toBe(all.length);
  });

  it("merchant slugs are the mock-world storeIds, with currency, region and timezone matching the store", () => {
    for (const p of shops) {
      const m = p.business.merchant;
      const store = PIZZA_STORES[m.slug];
      expect(store).toMatchObject({ storeId: m.slug, currency: m.currency, region: m.region, timezone: m.timezone, name: m.name });
      expect(p.user).toMatchObject({ homeCurrency: m.currency, region: m.region });
      expect(p.accountType).toBe("BUSINESS");
    }
    expect(pizzeriaBud.business.merchant).toMatchObject({ slug: "bud", currency: "HUF", region: "EU", timezone: "Europe/Budapest" });
    expect(pizzeriaSha.business.merchant).toMatchObject({ slug: "sha", currency: "CNY", region: "CN", timezone: "Asia/Shanghai" });
  });

  it("every menu SKU of both stores has a recipe, and every recipe SKU is an inventory item", () => {
    for (const p of shops) {
      const inv = new Set(p.business.inventory.map((i) => i.sku));
      for (const m of PIZZA_MENUS[p.business.merchant.slug]) expect(p.business.recipes.some((r) => r.menuSku === m.sku), m.sku).toBe(true);
      for (const r of p.business.recipes) expect(inv.has(r.inventorySku), r.inventorySku).toBe(true);
    }
    expect(PIZZA_MENUS.bud.map((m) => m.sku)).toEqual([...MENU_SKUS]);
    expect(PIZZA_MENUS.sha.map((m) => m.sku)).toEqual([...MENU_SKUS]);
  });

  it("28 completed days of sales per menu SKU, with weekend peaks", () => {
    for (const p of shops) {
      const days = [...new Set(p.business.salesDaily.map((s) => s.day))].sort();
      expect(days).toHaveLength(28);
      expect(days.at(-1)).toBe("2026-10-26");
      expect(p.business.salesDaily).toHaveLength(28 * MENU_SKUS.length);
      const pizzasOn = (wd: number) =>
        p.business.salesDaily.filter((s) => s.menuSku.startsWith("PZ-") && new Date(`${s.day}T12:00:00Z`).getUTCDay() === wd).reduce((a, s) => a + s.qty, 0);
      expect(pizzasOn(6)).toBeGreaterThan(pizzasOn(1)); // Saturday > Monday
    }
  });

  it("the stock ledger never goes negative and is consistent with sales (SALE = recipe × qty sold)", () => {
    for (const p of shops) {
      for (const item of p.business.inventory) {
        const mv = p.business.stockMovements.filter((m) => m.sku === item.sku).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
        let level = 0;
        for (const m of mv) {
          level += m.qty;
          expect(level, `${p.persona} ${item.sku} ${m.occurredAt}`).toBeGreaterThanOrEqual(0);
        }
        const sold = p.business.salesDaily.reduce(
          (a, s) => a + s.qty * (p.business.recipes.find((r) => r.menuSku === s.menuSku && r.inventorySku === item.sku)?.qtyPerUnit ?? 0),
          0,
        );
        expect(-mv.filter((m) => m.kind === "SALE").reduce((a, m) => a + m.qty, 0)).toBe(sold);
      }
    }
  });

  it("forecast contract: Shanghai is SHA_BOX_SHORTAGE (400) boxes short by the end of tomorrow; Budapest has no shortage", () => {
    expect(SHA_BOX_SHORTAGE).toBe(400);
    const sha = seedForecastShortage(pizzeriaSha.business);
    expect(sha["BOX-33CM"]!.shortage).toBe(400);
    for (const [sku, f] of Object.entries(sha)) if (sku !== "BOX-33CM") expect(f.shortage, sku).toBe(0);
    const bud = seedForecastShortage(pizzeriaBud.business);
    for (const [sku, f] of Object.entries(bud)) {
      expect(f.shortage, sku).toBe(0);
      expect(f.onHand, sku).toBeGreaterThan(f.need + f.safety); // comfortably stocked
    }
  });

  it("suppliers: a VERIFIED supplier and a COOLING attacker per shop; packs match the mock-world catalogs", () => {
    const bud = pizzeriaBud.payees;
    expect(bud.map((p) => [p.name, p.status, p.account])).toEqual([
      [SUPPLIERS.a.name, "VERIFIED", SUPPLIERS.a.iban],
      [SUPPLIERS.b.name, "COOLING", SUPPLIERS.b.iban],
    ]);
    const sha = pizzeriaSha.payees;
    expect(sha.map((p) => [p.name, p.status, p.currency])).toEqual([
      [SUPPLIERS.c.name, "VERIFIED", "CNY"],
      [SUPPLIERS.d.name, "COOLING", "CNY"],
    ]);
    for (const p of [...bud, ...sha]) {
      expect(p.kind).toBe("SUPPLIER");
      if (p.status === "VERIFIED") expect(Date.parse(p.verifiedAt!)).toBeLessThan(SEED_NOW);
      else expect(Date.parse(p.coolingUntil!)).toBeGreaterThan(SEED_NOW + DAY_MS);
    }
    for (const s of [SUPPLIERS.c, SUPPLIERS.d]) expect(QR_MERCHANTS[s.qrMerchantId]?.name).toBe(s.name);
    expect(QR_MERCHANTS[PIZZA_STORES.sha.id]?.name).toBe("Pizza Shop in Shanghai");
    for (const key of ["a", "b", "c", "d"] as const) {
      for (const pack of SUPPLIER_PACKS[key]) {
        const item = SUPPLIERS[key].items.find((i) => i.sku === pack.supplierSku);
        expect(item, `${key} ${pack.supplierSku}`).toBeDefined();
        expect(item!.priceMinor).toBe(pack.packPriceMinor);
      }
      expect(SUPPLIERS[key].items.some((i) => i.sku === "BOX-33CM-100"), key).toBe(true);
    }
  });

  it("a restock of the Shanghai shortage fits the PO cap and the owner's per-payment cap", () => {
    const box = SUPPLIER_PACKS.c.find((x) => x.supplierSku === "BOX-33CM-100")!;
    const total = Math.ceil(SHA_BOX_SHORTAGE / box.packSize) * box.packPriceMinor;
    expect(total).toBeLessThanOrEqual(pizzeriaSha.business.merchant.poCapMinor);
    expect(total).toBeLessThanOrEqual(pizzeriaSha.profile.caps.perPaymentMinor);
    expect(pizzeriaBud.business.merchant.poCapMinor).toBeLessThanOrEqual(pizzeriaBud.profile.caps.perPaymentMinor);
  });

  it("Li Wei in Shanghai: region CN, HANDOFF, pays the Shanghai pizzeria (a QR merchant)", () => {
    expect(liWeiCn.user).toMatchObject({ displayName: "Li Wei", region: "CN", moneyMode: "HANDOFF", homeCurrency: "CNY" });
    expect(liWeiCn.payees[0]!.name).toBe(PIZZA_STORES.sha.name);
    expect(liWei.user.region).toBe("EU"); // the original persona is unchanged
  });
});
