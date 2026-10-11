/*
 * D-CN2 Alipay/WeChat Pay-style capture: the CN notification samples are logged in CNY, converted to KZT at the
 * purchase-date rate and budgeted (I6: capture only logs); the CNY charge on the home KZT card later settles with a
 * hidden +4 % markup and the fee x-ray shows it. Regression: the settlement trigger only settles charges on a card
 * billed in the home currency (before the fix it settled the older card-less Alipay wallet charge).
 */
import { and, eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { notifications, payments, proposals, transactions, webauthnCredentialsPayments, webauthnCredentialsRules } from "../../src/db/schema.ts";
import { cardFees } from "../../src/modules/budget/index.ts";
import { ingestCapture } from "../../src/modules/capture/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { SoftAuthenticator } from "../helpers/webauthn.ts";
import { IDS } from "../../../../fixtures/seed-data.ts";

const t = useTestDb();
const app = useTestApp();

/** Seeded Dana (no personas), with a passkey in both credential tables and signed base rules. */
async function seededDana() {
  const { userId } = await seedDatabase(getDb(), await loadSeedData(), { reset: true });
  const auth = new SoftAuthenticator();
  const row = { userId, credentialId: auth.id, publicKey: auth.publicKeyB64u(), counter: 0, transports: ["internal"] };
  await getDb().insert(webauthnCredentialsRules).values(row);
  await getDb().insert(webauthnCredentialsPayments).values(row);
  await signBaseRules(userId, auth);
  return { userId, auth };
}

async function trigger(scenario: string) {
  const res = await app().inject({ method: "POST", url: `/api/demo/trigger/${scenario}` });
  expect(res.statusCode).toBe(200);
  return res.json().result as Record<string, unknown>;
}

const alipayRaw = () => readFileSync(new URL("../../../../fixtures/notifications/alipay-cn-purchase.txt", import.meta.url), "utf8");

describe("D-CN2 Alipay/WeChat Pay-style capture and KZT card settlement", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });
  it("cn-spending-day logs three CNY notices, converts them to KZT and sends budget notifications", async () => {
    const { userId } = await seededDana();
    const before = await getDb()
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.kind, "BUDGET_EACH")));

    const res = await app().inject({ method: "POST", url: "/api/demo/trigger/cn-spending-day" });
    expect(res.statusCode).toBe(200);
    const captured = res.json().result.captured as Array<Record<string, unknown>>;
    expect(captured).toHaveLength(3);

    expect(captured[0]).toMatchObject({
      sample: "alipay-cn-purchase.txt",
      status: "LOGGED",
      parsedBy: "PARSER:ALIPAY",
      amountMinor: 3250,
      currency: "CNY",
      homeAmountMinor: 239_795,
      category: "groceries",
    });
    expect(captured[1]).toMatchObject({
      sample: "wechat-pay-cn-purchase.txt",
      status: "LOGGED",
      parsedBy: "PARSER:WECHAT_PAY",
      amountMinor: 4500,
      currency: "CNY",
      homeAmountMinor: 332_024,
      category: "eating_out",
    });
    expect(captured[2]).toMatchObject({
      sample: "kz-bank-ru-cny-purchase.txt",
      status: "LOGGED",
      parsedBy: "PARSER:KZ_BANK",
      merchantNorm: "buy everything shop from china",
      amountMinor: 26_800,
      currency: "CNY",
      homeAmountMinor: 1_977_388,
    });

    const notif = captured[0]!.notification as { en: { body: string } };
    expect(notif.en.body).toMatch(/CN¥32\.50 at Convenience Store \(sample\)\. Groceries: \d+% used/);
    const notif2 = captured[1]!.notification as { en: { body: string } };
    expect(notif2.en.body).toMatch(/CN¥45\.00 at Noodle House \(sample\)\. Eating out:/);

    const [alipayTx] = await getDb()
      .select()
      .from(transactions)
      .where(eq(transactions.id, captured[0]!.transactionId as string));
    // Converted with the rate for the purchase date (2026-10-26 Shanghai time). Offline, the only table is the
    // labelled example table, which carries its own date (fixtures/fx-rates.json: 2026-10-27).
    expect(alipayTx).toMatchObject({ cardId: null, status: "PENDING", rateDate: "2026-10-27" });
    expect(alipayTx!.occurredAt).toEqual(new Date("2026-10-26T04:30:41Z"));

    const [kzTx] = await getDb()
      .select()
      .from(transactions)
      .where(eq(transactions.id, captured[2]!.transactionId as string));
    expect(kzTx).toMatchObject({ cardId: IDS.cards.kzt, status: "PENDING" });

    // Seeding does not create BUDGET_EACH rows; the count is compared before and after the trigger anyway.
    const after = await getDb()
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.kind, "BUDGET_EACH")));
    expect(after.length - before.length).toBe(2);

    // I6: capture only logs. Nothing is proposed or paid.
    expect(await getDb().select().from(proposals).where(eq(proposals.userId, userId))).toHaveLength(0);
    expect(await getDb().select().from(payments).where(eq(payments.userId, userId))).toHaveLength(0);
  });

  it("settlement settles the CNY charge on the KZT card with a hidden 4 % markup; the fee x-ray shows it; no DCC", async () => {
    const { userId } = await seededDana();
    const cn = await trigger("cn-spending-day");
    const kzCapture = (cn.captured as Array<Record<string, unknown>>)[2]!;
    const kzTxId = kzCapture.transactionId as string;

    const s = await trigger("settlement");
    expect(s).toMatchObject({
      settled: true,
      result: {
        transactionId: kzTxId,
        feeHomeMinor: 79_096,
        markupBps: 400,
        dcc: null,
        cardProfile: { cardId: IDS.cards.kzt, fromCurrency: "CNY", toCurrency: "KZT", medianMarkupBps: 400, samples: 1 },
      },
    });

    const [kz] = await getDb().select().from(transactions).where(eq(transactions.id, kzTxId));
    expect(kz).toMatchObject({ status: "SETTLED", settledCurrency: "KZT", settledAmountMinor: 2_056_484, feeHomeMinor: 79_096 });

    const [alipay] = await getDb()
      .select()
      .from(transactions)
      .where(eq(transactions.id, (cn.captured as Array<Record<string, unknown>>)[0]!.transactionId as string));
    expect(alipay).toMatchObject({ status: "PENDING", cardId: null });

    const feeNotes = await getDb()
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.kind, "FEES_SETTLED")));
    expect(feeNotes.length).toBeGreaterThanOrEqual(1);
    const feeBody = feeNotes.map((n) => n.body).join("\n");
    expect(feeBody).toContain("KZT\u00a0790.96"); // Intl.NumberFormat puts a no-break space after the code
    expect(feeBody).toContain("4.00% over mid");

    const fees = await cardFees(userId);
    expect(fees.dccWarnings).toEqual([]);
    expect(fees.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cardId: IDS.cards.kzt, fromCurrency: "CNY", toCurrency: "KZT", medianMarkupBps: 400, samples: 1 }),
      ]),
    );
    expect(fees.monthlyFeesLostHomeMinor).toBeGreaterThanOrEqual(79_096);
  });

  it("regression: the settlement trigger never settles a card-less wallet charge", async () => {
    const { userId } = await seededDana();
    const a = await ingestCapture(userId, { source: "NOTIF_SIM", rawText: alipayRaw() });
    expect(a.transactionId).toEqual(expect.any(String));

    const s = await trigger("settlement");
    expect(s.settled).toBe(true);
    const settled = s.result as { transactionId: string };
    expect(settled.transactionId).not.toBe(a.transactionId);

    // The settled charge is the oldest pending foreign charge on the KZT card from the seed: the HUF market hall.
    const [target] = await getDb().select().from(transactions).where(eq(transactions.id, settled.transactionId));
    expect(target).toMatchObject({ cardId: IDS.cards.kzt, status: "SETTLED", merchantNorm: "market hall in" });

    const [alipay] = await getDb().select().from(transactions).where(eq(transactions.id, a.transactionId!));
    expect(alipay).toMatchObject({ status: "PENDING", cardId: null, feeHomeMinor: null });
  });
});
