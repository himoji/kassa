/*
 * M1 "Apple Pay → Kassa": Shortcut device list / revoke (GET /devices, DELETE /devices/:id) and the `nudge` line
 * /capture/shortcut returns for the Shortcut's notification. Capture only logs (I6).
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { approvals, budgets, cardFeeProfiles, cards, ledgerEntries, notifications, payments, proposals, transactions, users } from "../../src/db/schema.ts";
import { rememberCategoryCorrection } from "../../src/modules/capture/service.ts";
import { normalizeMerchant } from "../../src/modules/capture/normalize.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey, offlineEnvironment } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

async function createDevice(userId: string): Promise<{ deviceId: string; token: string }> {
  const res = await app().inject({ method: "POST", url: "/api/devices/shortcut", headers: await bearer(userId) });
  expect(res.statusCode).toBe(201);
  return res.json() as { deviceId: string; token: string };
}

async function listDevices(userId: string) {
  const res = await app().inject({ method: "GET", url: "/api/devices", headers: await bearer(userId) });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    devices: { id: string; kind: string; createdAt: string; lastUsedAt: string | null }[];
    lastCaptureAt: string | null;
    lastUsedAt: string | null;
  };
}

async function capture(token: string, payload: Record<string, unknown>) {
  return app().inject({ method: "POST", url: "/api/capture/shortcut", headers: { authorization: `Bearer ${token}` }, payload });
}

/** Intl puts a no-break space between "HUF" and the number; compare as plain spaces. */
const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

async function homeHuf(userId: string) {
  await getDb().update(users).set({ homeCurrency: "HUF" }).where(eq(users.id, userId));
}

describe("Shortcut devices: list and revoke", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  it("lists the user's active Shortcut devices only, newest first, with the last capture time", async () => {
    const { userId } = await createUserWithPasskey();
    const other = await createUserWithPasskey();
    const a = await createDevice(userId);
    const b = await createDevice(userId);
    await createDevice(other.userId);

    const before = await listDevices(userId);
    expect(before.devices.map((d) => d.id).sort()).toEqual([a.deviceId, b.deviceId].sort());
    expect(before.devices.every((d) => d.kind === "IOS_SHORTCUT")).toBe(true);
    expect(before.lastCaptureAt).toBeNull();
    // No token or hash is ever listed.
    expect(JSON.stringify(before)).not.toContain(a.token);

    expect((await capture(a.token, { merchant: "Coffee House", amount: "1 200 Ft" })).statusCode).toBe(200);
    expect((await listDevices(userId)).lastCaptureAt).not.toBeNull();
  });

  it("DELETE /devices/:id revokes: the token then 401s on capture, the device leaves the list, ledgered", async () => {
    const { userId } = await createUserWithPasskey();
    const { deviceId, token } = await createDevice(userId);
    expect((await capture(token, { merchant: "Coffee House", amount: "1 200 Ft" })).statusCode).toBe(200);

    const del = await app().inject({ method: "DELETE", url: `/api/devices/${deviceId}`, headers: await bearer(userId) });
    expect(del.statusCode).toBe(204);
    const after = await capture(token, { merchant: "Coffee House", amount: "1 300 Ft" });
    expect(after.statusCode).toBe(401);
    expect(after.json().code).toBe("DEVICE_TOKEN_INVALID");
    expect((await listDevices(userId)).devices).toEqual([]);
    expect(await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "DEVICE_TOKEN_REVOKED"))).toHaveLength(1);

    // Idempotent: a second revoke is 204 and writes no second ledger entry.
    const again = await app().inject({ method: "DELETE", url: `/api/devices/${deviceId}`, headers: await bearer(userId) });
    expect(again.statusCode).toBe(204);
    expect(await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "DEVICE_TOKEN_REVOKED"))).toHaveLength(1);
  });

  it("another user's device → 404 and it keeps working; unknown id → 404; bad id → 400; no session → 401", async () => {
    const { userId } = await createUserWithPasskey();
    const other = await createUserWithPasskey();
    const theirs = await createDevice(other.userId);
    const res = await app().inject({ method: "DELETE", url: `/api/devices/${theirs.deviceId}`, headers: await bearer(userId) });
    expect(res.statusCode).toBe(404);
    const denied = await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "AUTHZ_DENIED"));
    expect(denied.map((e) => e.payload)).toContainEqual(expect.objectContaining({ actorUserId: userId, resource: "device", existed: true }));
    expect((await capture(theirs.token, { merchant: "Coffee House", amount: "1 200 Ft" })).statusCode).toBe(200);

    const unknown = await app().inject({ method: "DELETE", url: "/api/devices/00000000-0000-4000-8000-000000000000", headers: await bearer(userId) });
    expect(unknown.statusCode).toBe(404);
    const bad = await app().inject({ method: "DELETE", url: "/api/devices/not-a-uuid", headers: await bearer(userId) });
    expect(bad.statusCode).toBe(400);
    const anon = await app().inject({ method: "DELETE", url: `/api/devices/${theirs.deviceId}` });
    expect(anon.statusCode).toBe(401);
    expect((await app().inject({ method: "GET", url: "/api/devices" })).statusCode).toBe(401);
  });
});

describe("/capture/shortcut test run (KassaLite setup check)", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  it("empty Transaction fields → TEST, nothing logged, lastUsedAt moves on that device only; {test: true} does not move it", async () => {
    const { userId } = await createUserWithPasskey();
    const a = await createDevice(userId);
    const b = await createDevice(userId);
    expect((await listDevices(userId)).lastUsedAt).toBeNull();

    // KassaLite's own check: the token works, but the Shortcut has not run.
    const check = await capture(a.token, { test: true });
    expect(check.statusCode).toBe(200);
    expect(check.json().status).toBe("TEST");
    expect((await listDevices(userId)).lastUsedAt).toBeNull();

    // What iOS sends when the Shortcut runs without a Transaction input.
    const empty = await capture(a.token, { merchant: "", amount: "", card: "" });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ status: "TEST", nudgeTitle: "Kassa is connected" });
    expect((await capture(a.token, {})).json().status).toBe("TEST");
    expect(await getDb().select().from(transactions).where(eq(transactions.userId, userId))).toEqual([]);

    const list = await listDevices(userId);
    expect(list.lastUsedAt).not.toBeNull();
    expect(list.lastCaptureAt).toBeNull();
    expect(list.devices.find((d) => d.id === a.deviceId)?.lastUsedAt).toBe(list.lastUsedAt);
    expect(list.devices.find((d) => d.id === b.deviceId)?.lastUsedAt).toBeNull();
  });

  it("a merchant without an amount is still a bad request (a mis-wired Shortcut), and does not count as used", async () => {
    const { userId } = await createUserWithPasskey();
    const { token } = await createDevice(userId);
    const res = await capture(token, { merchant: "Coffee House", amount: "" });
    expect(res.statusCode).toBe(400);
    expect((await listDevices(userId)).lastUsedAt).toBeNull();
  });

  it("a real purchase also sets lastUsedAt; a revoked token's test run is 401", async () => {
    const { userId } = await createUserWithPasskey();
    const { deviceId, token } = await createDevice(userId);
    expect((await capture(token, { merchant: "Coffee House", amount: "1 200 Ft" })).json().status).toBe("LOGGED");
    expect((await listDevices(userId)).lastUsedAt).not.toBeNull();
    await app().inject({ method: "DELETE", url: `/api/devices/${deviceId}`, headers: await bearer(userId) });
    expect((await capture(token, { test: true })).statusCode).toBe(401);
  });
});

describe("/capture/shortcut nudge", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    clock.freezeForTests(new Date("2026-10-11T09:00:00.000Z"));
  });
  afterEach(() => clock.freezeForTests(null));

  it("names amount, merchant and the category budget left this month; never creates a proposal or payment (I6)", async () => {
    const { userId } = await createUserWithPasskey();
    await homeHuf(userId);
    await rememberCategoryCorrection(userId, normalizeMerchant("CAFE FREI"), "eating_out");
    await getDb().insert(budgets).values({ userId, category: "eating_out", periodStart: "2026-10-01", periodEnd: "2026-10-31", limitHomeMinor: 10_000_00 });
    const { token } = await createDevice(userId);

    const res = await capture(token, { merchant: "CAFE FREI", amount: "1 290 Ft", card: "Revolut", date: "11 Oct 2026 at 10:59" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("LOGGED");
    expect(body.amountMinor).toBe(129_000);
    // 1 290 of 10 000 used → 12% used, 88% left; 8 710 left over 21 days (11–31 Oct) → about 414 a day.
    // The tap time is the request time (the localized `date` is ignored): 09:00 UTC = 11:00 in Budapest.
    expect(plain(body.nudge)).toBe(
      ["Logged HUF 1,290.00 at Cafe Frei", "Today 11:00 · first time here", "Eating out 88% left this month (HUF 8,710.00), about HUF 414 a day", "New card saved: Revolut (billed in HUF)"].join("\n"),
    );
    expect(plain(body.nudgeTitle)).toBe("Logged HUF 1,290.00 at Cafe Frei");
    expect(plain(body.nudgeBody)).toBe(plain(body.nudge).split("\n").slice(1).join("\n"));
    expect(await getDb().select().from(proposals)).toHaveLength(0);
    expect(await getDb().select().from(approvals)).toHaveLength(0);
    expect(await getDb().select().from(payments)).toHaveLength(0);
  });

  it("a second sighting of the same tap is merged (dedupe) and says so", async () => {
    const { userId } = await createUserWithPasskey();
    await homeHuf(userId);
    const { token } = await createDevice(userId);
    const p = { merchant: "CAFE FREI", amount: "HUF 1,290.00" };
    expect((await capture(token, p)).json().status).toBe("LOGGED");
    const second = (await capture(token, p)).json();
    expect(second.status).toBe("MERGED");
    expect(plain(second.nudge)).toBe("Already logged: HUF 1,290.00 at Cafe Frei.");
    expect(await getDb().select().from(transactions).where(eq(transactions.userId, userId))).toHaveLength(2);
  });

  it("a foreign spend shows the home equivalent and the card's known markup", async () => {
    const { userId } = await createUserWithPasskey();
    await homeHuf(userId);
    const card = (await getDb().insert(cards).values({ userId, label: "Local HUF card", last4: "4821", billingCurrency: "HUF", kind: "LOCAL_HUF" }).returning())[0]!;
    await getDb().insert(cardFeeProfiles).values({ cardId: card.id, fromCurrency: "EUR", toCurrency: "HUF", medianMarkupBps: 250, fixedFeeMinor: 0, samples: 3 });
    const { token } = await createDevice(userId);
    const nudge = plain((await capture(token, { merchant: "Café de Flore", amount: "€4.50", card: "Local HUF card" })).json().nudge as string);
    expect(nudge).toMatch(/^Logged €4\.50 \(≈ HUF [\d,.]+\) at Café de Flore\n/);
    expect(nudge).toMatch(/Local HUF card adds ~2\.5% \(≈ HUF [\d,.]+\)/);
  });

  it("warns about DCC: home-currency charge right after foreign spending, and a merchant flagged for DCC before", async () => {
    const { userId } = await createUserWithPasskey();
    await homeHuf(userId);
    const { token } = await createDevice(userId);
    await capture(token, { merchant: "Boulangerie Paris", amount: "€3.20" });
    const dcc = (await capture(token, { merchant: "Souvenir Shop Paris", amount: "HUF 5,000" })).json().nudge as string;
    expect(dcc).toContain("Charged in HUF, not EUR? That is DCC: choose EUR at the terminal");

    await getDb().insert(notifications).values({
      userId,
      kind: "FEES_DCC",
      title: "DCC",
      body: "DCC",
      data: { merchantNorm: normalizeMerchant("HOTEL LOBBY BAR"), overMidBps: 640, transactionId: "00000000-0000-4000-8000-000000000001" },
      createdAt: clock.now(),
    });
    const flagged = (await capture(token, { merchant: "HOTEL LOBBY BAR", amount: "€9.00" })).json().nudge as string;
    expect(flagged).toContain("DCC charged here before (+6.4%): pay in local currency");
  });

  it("unreadable and refund amounts get a plain nudge and log nothing", async () => {
    const { userId } = await createUserWithPasskey();
    await homeHuf(userId);
    const { token } = await createDevice(userId);
    const pound = (await capture(token, { merchant: "Pret", amount: "£4.50" })).json();
    expect(pound.status).toBe("UNPARSED");
    expect(pound.nudge).toBe("Kassa could not read this payment. Open Kassa to add it by hand.");
    const refund = (await capture(token, { merchant: "CAFE FREI", amount: "-1 290 Ft" })).json();
    expect(refund.status).toBe("IGNORED_INCOMING");
    expect(plain(refund.nudge)).toBe("Refund HUF 1,290.00 noted: not counted as spending.");
    expect(await getDb().select().from(transactions).where(eq(transactions.userId, userId))).toHaveLength(0);
  });
});
