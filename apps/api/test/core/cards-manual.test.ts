/* Cards added by hand (POST /cards, DELETE /cards/:id): last 4 digits only, any ISO 4217 currency, owner-scoped. */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { cards, transactions } from "../../src/db/schema.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

const add = async (userId: string, payload: Record<string, unknown>) =>
  app().inject({ method: "POST", url: "/api/cards", headers: await bearer(userId), payload });

describe("cards added by hand", () => {
  beforeEach(async () => {
    await t.reset();
  });

  it("adds a card in any ISO currency, lists it, refuses duplicates and full numbers", async () => {
    const { userId } = await createUserWithPasskey();
    const res = await add(userId, { label: "TBC Visa", last4: "4821", billingCurrency: "GEL", kind: "MULTI" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ label: "TBC Visa", last4: "4821", billingCurrency: "GEL", kind: "MULTI" });

    const list = await app().inject({ method: "GET", url: "/api/cards", headers: await bearer(userId) });
    expect(list.json().cards).toHaveLength(1);

    expect((await add(userId, { label: "TBC Visa", last4: "4821", billingCurrency: "GEL", kind: "MULTI" })).statusCode).toBe(409);
    expect((await add(userId, { label: "Full", last4: "4111111111111111", billingCurrency: "EUR", kind: "MULTI" })).statusCode).toBe(400);
    expect((await add(userId, { label: "Fake", last4: "1234", billingCurrency: "ABC", kind: "MULTI" })).statusCode).toBe(400);
  });

  it("lists a card learned from an Apple Pay tap without digits (empty last4) instead of failing with 500", async () => {
    const { userId } = await createUserWithPasskey();
    await getDb().insert(cards).values({ userId, label: "Revolut", last4: "", billingCurrency: "EUR", kind: "MULTI" });
    const list = await app().inject({ method: "GET", url: "/api/cards", headers: await bearer(userId) });
    expect(list.statusCode).toBe(200);
    expect(list.json().cards).toEqual([expect.objectContaining({ label: "Revolut", last4: "" })]);
  });

  it("removes only the owner's card and keeps past spending without it", async () => {
    const { userId } = await createUserWithPasskey();
    const other = await createUserWithPasskey();
    const card = (await add(userId, { label: "Kaspi", last4: "1111", billingCurrency: "KZT", kind: "HOME_KZT" })).json() as { id: string };
    await getDb()
      .insert(transactions)
      .values({ userId, occurredAt: new Date(), amountMinor: 500, currency: "KZT", cardId: card.id, merchantRaw: "Cafe", merchantNorm: "cafe", category: "eating_out", source: "TEXT" } as never);

    const foreign = await app().inject({ method: "DELETE", url: `/api/cards/${card.id}`, headers: await bearer(other.userId) });
    expect(foreign.statusCode).toBe(404);

    const del = await app().inject({ method: "DELETE", url: `/api/cards/${card.id}`, headers: await bearer(userId) });
    expect(del.statusCode).toBe(204);
    expect(await getDb().select().from(cards).where(eq(cards.userId, userId))).toHaveLength(0);
    const tx = await getDb().select({ cardId: transactions.cardId }).from(transactions).where(eq(transactions.userId, userId));
    expect(tx).toEqual([{ cardId: null }]);
  });
});
