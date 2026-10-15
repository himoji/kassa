/* POST /import/file, /import/commit with history, POST /onboarding/history (IMPORT_PLAN S9, S11). */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { agentMessages } from "../../src/db/schema.intel.ts";
import { cards, payees, profiles, transactions, users } from "../../src/db/schema.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey, offlineEnvironment } from "../helpers/fixtures.ts";
import { HOLDER_EN, IBAN_KZ, KASPI_TEXT, textPdf, US_ACCOUNT, US_TEXT } from "./statements.ts";

const t = useTestDb();
const app = useTestApp();

/** multipart/form-data body (RFC 7578) with files and fields. */
function multipart(files: { name: string; data: Uint8Array; type?: string }[], fields: Record<string, string> = {}) {
  const boundary = `----kassa${randomUUID()}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: ${f.type ?? "application/octet-stream"}\r\n\r\n`));
    parts.push(Buffer.from(f.data));
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe("statement import over HTTP", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  it("reads several statements, commits spending with the amount really charged, cards, incomes; never an account", async () => {
    const { userId } = await createUserWithPasskey();
    await getDb().update(users).set({ homeCurrency: "KZT", displayName: "Dana Seitkali" }).where(eq(users.id, userId));
    const headers = await bearer(userId);
    const body = multipart([
      { name: "kaspi.txt", data: new TextEncoder().encode(KASPI_TEXT), type: "text/plain" },
      { name: "us.pdf", data: await textPdf(US_TEXT.split("\n")), type: "image/png" },
    ]);
    const res = await app().inject({ method: "POST", url: "/api/import/file", headers: { ...headers, ...body.headers }, payload: body.payload });
    expect(res.statusCode).toBe(200);
    const preview = res.json();
    expect(preview.files.map((f: { format: string; via: string; bank: string | null }) => [f.format, f.via, f.bank])).toEqual([
      ["text", "lines", "Kaspi"],
      ["pdf", "lines", null],
    ]);
    expect(JSON.stringify(preview)).not.toContain(IBAN_KZ);
    expect(JSON.stringify(preview)).not.toContain(US_ACCOUNT);
    expect(preview.items.cards).toEqual([expect.objectContaining({ last4: "4821", billingCurrency: "KZT" })]);
    expect(preview.items.incomes.length).toBeGreaterThan(0);

    const commit = await app().inject({ method: "POST", url: "/api/import/commit", headers, payload: { items: { ...preview.items, budgets: [] } } });
    expect(commit.statusCode).toBe(200);
    expect(commit.json().incomes.added).toBe(preview.items.incomes.length);
    const rows = await getDb().select().from(transactions).where(eq(transactions.userId, userId));
    // The cinema ticket: 4 000 HUF, settled 5 519,45 KZT; the fee x-ray has its fee against the mid rate.
    const cinema = rows.find((r) => r.merchantRaw === "CINEMA CITY" && r.currency === "HUF")!;
    expect(cinema).toMatchObject({ amountMinor: 400000, settledAmountMinor: 551945, settledCurrency: "KZT", status: "SETTLED" });
    expect(cinema.feeHomeMinor).not.toBeNull();
    expect(cinema.cardId).not.toBeNull();
    expect(rows.some((r) => r.merchantRaw.includes("Депозит") || r.merchantRaw.startsWith("ДАНА"))).toBe(false);
    const profile = (await getDb().select().from(profiles).where(eq(profiles.userId, userId)))[0]!;
    expect(profile.incomes.map((i) => i.source)).toContain("Нұрлан С.");
    expect(await getDb().select().from(payees).where(eq(payees.userId, userId))).toHaveLength(0);
    expect(await getDb().select().from(cards).where(eq(cards.userId, userId))).toHaveLength(1);
  });

  it("two same-price coffees on one day are two purchases; importing the statement again adds nothing", async () => {
    const { userId } = await createUserWithPasskey();
    const headers = await bearer(userId);
    const csv = "Date,Description,Amount,Currency\n03.10.2026,Coffee Corner,-1200.00,HUF\n03.10.2026,Coffee Corner,-1200.00,HUF\n04.10.2026,SPAR,-3500.00,HUF\n";
    const body = multipart([{ name: "s.csv", data: new TextEncoder().encode(csv) }]);
    const preview = (await app().inject({ method: "POST", url: "/api/import/file", headers: { ...headers, ...body.headers }, payload: body.payload })).json();
    const first = await app().inject({ method: "POST", url: "/api/import/commit", headers, payload: { items: preview.items } });
    expect(first.json().transactions).toEqual({ imported: 3, duplicates: 0, failed: 0 });
    const again = await app().inject({ method: "POST", url: "/api/import/commit", headers, payload: { items: preview.items } });
    expect(again.json().transactions).toEqual({ imported: 0, duplicates: 3, failed: 0 });
  });

  it("refuses what it cannot read with a reason, and needs a file", async () => {
    const { userId } = await createUserWithPasskey();
    const headers = await bearer(userId);
    const xls = multipart([{ name: "old.xls", data: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) }]);
    const bad = await app().inject({ method: "POST", url: "/api/import/file", headers: { ...headers, ...xls.headers }, payload: xls.payload });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().detail).toMatch(/xlsx or \.csv/);
    const none = await app().inject({ method: "POST", url: "/api/import/file", headers: { ...headers, ...multipart([]).headers }, payload: multipart([]).payload });
    expect(none.statusCode).toBe(400);
    const json = await app().inject({ method: "POST", url: "/api/import/file", headers, payload: { file: "x" } });
    expect(json.statusCode).toBe(415);
  });
});

describe("bank history in onboarding", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  it("prefills the draft in code, writes the reply from the numbers, and keeps only aggregates for the model", async () => {
    const { userId } = await createUserWithPasskey();
    await getDb().update(users).set({ homeCurrency: "KZT", displayName: HOLDER_EN }).where(eq(users.id, userId));
    const headers = await bearer(userId);
    const body = multipart([{ name: "kaspi.txt", data: new TextEncoder().encode(KASPI_TEXT) }]);
    const preview = (await app().inject({ method: "POST", url: "/api/import/file", headers: { ...headers, ...body.headers }, payload: body.payload })).json();
    const conversationId = randomUUID();
    const res = await app().inject({
      method: "POST",
      url: "/api/onboarding/history",
      headers,
      payload: { conversationId, history: preview.history, files: preview.files, items: { incomes: preview.items.incomes, bills: preview.items.bills, budgets: preview.items.budgets, cards: preview.items.cards } },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.reply).toMatch(/I read \*\*\d+ transactions\*\* from Kaspi/);
    expect(out.reply).toContain("Нұрлан С.");
    expect(out.draft.incomes).toEqual([expect.objectContaining({ source: "Нұрлан С.", cadence: "MONTHLY" })]);
    expect(out.draft.cards).toEqual([expect.objectContaining({ last4: "4821" })]);
    expect(out.complete).toBe(false);

    // What the model will see next turn: aggregates, people as placeholders, no statement rows or accounts.
    const stored = await getDb().select().from(agentMessages).where(eq(agentMessages.conversationId, conversationId));
    const forModel = JSON.stringify(stored.map((m) => m.message));
    expect(forModel).toContain("Bank history imported");
    expect(forModel).not.toContain("Нұрлан С.");
    expect(forModel).toMatch(/person_\d/);
    expect(forModel).not.toContain(IBAN_KZ);
    expect(forModel).not.toContain("CINEMA CITY");

    // Another user's conversation id is refused like a missing one.
    const other = await createUserWithPasskey();
    const stolen = await app().inject({ method: "POST", url: "/api/onboarding/history", headers: await bearer(other.userId), payload: { conversationId, history: preview.history, files: preview.files, items: { incomes: [], bills: [], budgets: [], cards: [] } } });
    expect(stolen.statusCode).toBe(404);
  });
});
