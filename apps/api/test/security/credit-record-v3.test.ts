/*
 * Credit record v3 (2026-10-19): signed with the credit record key over a domain-separated message, the keys published
 * as a JWKS (GET /public/keys) and checkable offline (credit-record/offline.ts, `bun run credit:verify`); the holder's
 * name bound by a keyed hash (verify ?name= answers match / no match); BUDGETS and PAYMENTS carry figures; a seeded
 * account's imported (simulated) history counts and moves the opening day back. v2 records keep verifying.
 */
import { jcsHash } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { budgets, ledgerEntries, transactions, users } from "../../src/db/schema.ts";
import { clock, isoDate } from "../../src/modules/clock/index.ts";
import { creditRecordPublicKey } from "../../src/modules/credit-record/keys.ts";
import { verifyCreditRecordOffline } from "../../src/modules/credit-record/offline.ts";
import { ACCOUNT_HISTORY_TYPE, type AccountHistory } from "../../src/modules/demo/accountHistory.ts";
import { addDays } from "../../src/modules/fx/dates.ts";
import { env } from "../../src/env.ts";
import { ledger } from "../../src/modules/ledger/index.ts";
import { keyIdOf, loadPrivateKey, publicFromPrivate, signText } from "../../src/modules/ledger/keys.ts";

const checkpointKey = () => loadPrivateKey(env().LEDGER_CHECKPOINT_KEY);
import { sealPii } from "../../src/modules/privacy/keys.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { addPayee, addPriorPayment, createUserWithPasskey, offlineEnvironment } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

beforeEach(async () => {
  await t.reset();
  offlineEnvironment();
  clock.setOffsetInMemoryForTests(0);
});

async function exportRecord(userId: string, payload: Record<string, unknown>) {
  const res = await app().inject({ method: "POST", url: "/api/credit-record/export", headers: await bearer(userId), payload });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { verifyId: string };
}
const fileOf = async (verifyId: string) => (await app().inject({ method: "GET", url: `/api/public/credit-record/${verifyId}.json` })).json();
const verify = async (verifyId: string, query = "") => {
  const res = await app().inject({ method: "GET", url: `/api/public/verify/${verifyId}${query}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};

describe("credit record v3: keys, signature, offline check", () => {
  it("publishes a JWKS; the record verifies offline with it, and fails on any change", async () => {
    const { userId } = await createUserWithPasskey();
    const { verifyId } = await exportRecord(userId, { from: "2000-01-01", to: "2099-12-31", items: ["BILLS"] });
    const keys = await app().inject({ method: "GET", url: "/api/public/keys" });
    expect(keys.statusCode).toBe(200);
    const jwks = keys.json() as { keys: { kid: string; kty: string; crv: string; x: string; use: string }[] };
    expect(jwks.keys.map((k) => [k.kty, k.crv, k.use])).toEqual([
      ["OKP", "Ed25519", "sig"],
      ["OKP", "Ed25519", "sig"],
    ]);
    // A key of its own, not the ledger checkpoint key.
    expect(jwks.keys[0]!.kid).toBe(keyIdOf(creditRecordPublicKey()));
    expect(jwks.keys[0]!.kid).not.toBe(keyIdOf(publicFromPrivate(checkpointKey())));

    const file = await fileOf(verifyId);
    expect(file.bundle.v).toBe(3);
    expect(file.keyId).toBe(jwks.keys[0]!.kid);
    expect(verifyCreditRecordOffline(file, jwks)).toMatchObject({ ok: true, hashMatches: true, keyFound: true, signatureValid: true, version: 3 });
    // Domain separation: the signature does not verify over the bare hash (the v1/v2 message).
    expect(verifyCreditRecordOffline({ ...file, bundle: { ...file.bundle, v: 2 }, sha256: jcsHash({ ...file.bundle, v: 2 }) }, jwks).ok).toBe(false);
    // A changed figure breaks the hash; a stranger's key set finds no key.
    expect(verifyCreditRecordOffline({ ...file, bundle: { ...file.bundle, summary: { ...file.bundle.summary, billsTotal: 9 } } }, jwks).hashMatches).toBe(false);
    expect(verifyCreditRecordOffline(file, { keys: [jwks.keys[1]!] }).keyFound).toBe(false);
  });

  it("a v2 record (bare-hash signature with the ledger key) still verifies", async () => {
    const { userId } = await createUserWithPasskey();
    const today = isoDate(clock.now());
    const bundle = { v: 2, verifyId: "legacy-v2-record-000001", issuedAt: clock.now().toISOString(), period: { from: today, to: today }, holder: "D.", items: ["BILLS"], summary: { monthsCovered: 1, billsTotal: 0, billsPaidOnTime: 0 }, simulated: true };
    const sha256 = jcsHash(bundle);
    const key = checkpointKey();
    await ledger.append("CREDIT_RECORD_EXPORTED", { userId, verifyId: bundle.verifyId, sha256, sig: signText(key, sha256), keyId: keyIdOf(publicFromPrivate(key)), ...(await sealPii(userId, { bundle })) });
    const v = await verify(bundle.verifyId);
    expect(v).toMatchObject({ valid: true, version: 2 });
    expect(v.holderNameSource).toBeUndefined();
    const jwks = (await app().inject({ method: "GET", url: "/api/public/keys" })).json();
    expect(verifyCreditRecordOffline(await fileOf(bundle.verifyId), jwks).ok).toBe(true);
  });
});

describe("credit record v3: the holder's name", () => {
  it("binds the full name: ?name= answers match / no match and never shows the name", async () => {
    const { userId } = await createUserWithPasskey();
    const { verifyId } = await exportRecord(userId, { from: "2000-01-01", to: "2099-12-31", items: ["INCOME"] });
    const file = await fileOf(verifyId);
    expect(file.bundle.holderName).toMatchObject({ source: "KYC" });
    const displayName = (await getDb().select().from(users).where(eq(users.id, userId)))[0]!.displayName;
    expect(JSON.stringify(file)).not.toContain(displayName);
    expect((await verify(verifyId, `?name=${encodeURIComponent(displayName)}`)).nameMatch).toBe(true);
    // Case, accents and spacing do not matter; another name does not match.
    expect((await verify(verifyId, `?name=${encodeURIComponent(`  ${displayName.toUpperCase()} `)}`)).nameMatch).toBe(true);
    expect((await verify(verifyId, "?name=Someone%20Else")).nameMatch).toBe(false);
    expect((await verify(verifyId)).nameMatch).toBeUndefined();
  });
});

describe("credit record v3: BUDGETS and PAYMENTS figures", () => {
  it("budgets within limit (to the issue day) and payments completed with the on-time share", async () => {
    const { userId } = await createUserWithPasskey();
    const today = isoDate(clock.now());
    const month = today.slice(0, 7);
    await getDb().insert(budgets).values([
      { userId, category: "groceries", periodStart: `${month}-01`, periodEnd: addDays(`${month}-01`, 27), limitHomeMinor: 9_000_000 },
      { userId, category: "eating_out", periodStart: `${month}-01`, periodEnd: addDays(`${month}-01`, 27), limitHomeMinor: 1_000_000 },
    ]);
    const tx = (category: string, amount: number) => ({ userId, source: "TEXT" as const, occurredAt: clock.now(), merchantRaw: "x", merchantNorm: "x", amountMinor: amount, currency: "KZT", homeAmountMinor: amount, category, status: "SETTLED" as const });
    await getDb().insert(transactions).values([tx("groceries", 2_000_000), tx("eating_out", 3_000_000)]);
    const shop = await addPayee(userId, { name: "Corner Shop", kind: "MERCHANT", currency: "KZT" });
    await addPriorPayment(userId, shop.id); // 40 days ago, SENT

    const { verifyId } = await exportRecord(userId, { from: "2000-01-01", to: "2099-12-31", items: ["BUDGETS", "PAYMENTS"] });
    const v = await verify(verifyId);
    expect(v.summary.budgetsTotal).toBe(2);
    expect(v.summary.budgetsWithinLimit).toBe(1);
    // The earlier payment predates the (clamped) period: the account was opened today.
    expect(v.summary.paymentsCompleted).toBe(0);
    expect(v.summary.paymentsOnTimePct).toBeUndefined();
    expect(v.summary.billsTotal).toBeUndefined();
  });

  it("a seeded account's imported history counts: opening day, bills on time, payments, income months", async () => {
    const { userId } = await createUserWithPasskey();
    const today = isoDate(clock.now());
    const history: AccountHistory = {
      userId,
      simulated: true,
      source: "seed",
      openedOn: addDays(today, -200),
      bills: [
        { obligationId: crypto.randomUUID(), category: "rent", period: addDays(today, -60), paidOn: addDays(today, -62), amountMinor: 1, currency: "HUF" },
        { obligationId: crypto.randomUUID(), category: "rent", period: addDays(today, -30), paidOn: addDays(today, -32), amountMinor: 1, currency: "HUF" },
      ],
      incomes: [
        { on: addDays(today, -65), amountMinor: 1, currency: "KZT" },
        { on: addDays(today, -35), amountMinor: 1, currency: "KZT" },
      ],
    };
    await ledger.append(ACCOUNT_HISTORY_TYPE, history);
    const { verifyId } = await exportRecord(userId, { from: addDays(today, -180), to: today, items: ["BILLS", "INCOME", "PAYMENTS"] });
    const v = await verify(verifyId);
    expect(v.accountOpenedOn).toBe(history.openedOn);
    expect(v.period.from).toBe(addDays(today, -180));
    expect(v.importedHistory).toEqual({ source: "seed", simulated: true, openedOn: history.openedOn });
    expect(v.summary).toMatchObject({ billsTotal: 2, billsPaidOnTime: 2, paymentsCompleted: 2, paymentsOnTimePct: 100 });
    expect(v.summary.incomeMonths).toBeGreaterThanOrEqual(2);
    // Recorded once, at the time it was imported: never back-dated in the ledger.
    const entry = (await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, ACCOUNT_HISTORY_TYPE)))[0]!;
    expect(isoDate(entry.ts)).toBe(today);
    expect((await ledger.verify()).ok).toBe(true);
  });
});
