/*
 * Y6 user-facing text: pretty merchant names (never normalised keys), home-currency equivalents on foreign capture
 * notifications, the fee x-ray's exampleValues flag under offline example rates, plain-language reason texts,
 * explicit preset-derived setting changes, the signed-maximum margin explained, and planner placeholders
 * re-hydrated before an order reaches the user.
 */
import {
  FUNDING_FX_TOLERANCE_BPS,
  fundingMarginNoteEn,
  presetDerivedChanges,
  REASON_TEXT_EN,
  ReasonCode,
  reasonsSentenceEn,
  reasonTextEn,
} from "@kassa/shared";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { IDS } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { notifications } from "../../src/db/schema.ts";
import { Redactor } from "../../src/modules/agent/redact.ts";
import { buildTools, type ToolContext } from "../../src/modules/agent/tools.ts";
import { cardFees } from "../../src/modules/budget/fees.ts";
import { notify } from "../../src/modules/notifications/service.ts";
import { merchantDisplayName } from "../../src/modules/capture/service.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { FX_TOLERANCE_BPS } from "../../src/modules/rules/funding.ts";
import { useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { offlineEnvironment } from "../helpers/fixtures.ts";
import { fakePorts, LANDLORD } from "./fakes.ts";

const t = useTestDb();
const app = useTestApp();

describe("shared plain-language helpers", () => {
  it("every reason code has a plain-language text; sentences keep the code next to the text", () => {
    for (const c of ReasonCode.options) expect(REASON_TEXT_EN[c], c).toBeTruthy();
    expect(reasonsSentenceEn(["HANDOFF_REGION"])).toBe(`Reasons: ${reasonTextEn("HANDOFF_REGION").replace(/\.$/, "")} (HANDOFF_REGION).`);
    expect(reasonsSentenceEn([])).toBe("Reasons: none.");
    expect(reasonTextEn("SOME_FUTURE_CODE")).toBe("Some future code.");
  });

  it("ASK_ME derives PAY_IN_PLACE from SMART's CAPPED_WALLET (p2 B6); an override suppresses it", () => {
    const none = { agentAutonomy: null, paymentPolicy: null, moneyMode: null };
    expect(presetDerivedChanges("SMART", "ASK_ME", none)).toContainEqual({ setting: "moneyMode", from: "CAPPED_WALLET", to: "PAY_IN_PLACE" });
    expect(presetDerivedChanges("SMART", "ASK_ME", { ...none, moneyMode: "CAPPED_WALLET" }).some((c) => c.setting === "moneyMode")).toBe(false);
    expect(presetDerivedChanges("SMART", "SMART", none)).toEqual([]);
  });

  it("the signed-max margin is explained and pinned to the rules' tolerance (p1 B9)", () => {
    expect(FUNDING_FX_TOLERANCE_BPS).toBe(FX_TOLERANCE_BPS);
    const note = fundingMarginNoteEn("KZT 1,493,622.02", "KZT");
    expect(note).toContain("up to 1%");
    expect(note).toContain("nothing is sent");
  });
});

describe("capture notifications and fee x-ray (seeded Dana, offline example rates)", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    await seedDatabase(getDb(), await loadSeedData(), { reset: true });
  });

  it("merchant display: dictionary name, else the user's payee name, else a title-cased raw name; never the key", async () => {
    expect(await merchantDisplayName(IDS.user, "coffee shop in", "COFFEE SHOP IN BUDAPEST")).toBe("Coffee Shop in Budapest");
    expect(await merchantDisplayName(IDS.user, "buy everything shop from china", "BUY EVERYTHING SHOP FROM CHINA")).toBe("Buy Everything Shop from China");
    expect(await merchantDisplayName(IDS.user, "corner kiosk", "CORNER KIOSK 12")).toBe("Corner Kiosk 12");
    expect(await merchantDisplayName(IDS.user, "coffee", "coffee")).toBe("coffee");
  });

  it("CNY capture notifications carry the KZT equivalent; the fee notice names the shop properly; exampleValues true", async () => {
    const cn = await app().inject({ method: "POST", url: "/api/demo/trigger/cn-spending-day" });
    expect(cn.statusCode, cn.body).toBe(200);
    const s = await app().inject({ method: "POST", url: "/api/demo/trigger/settlement" });
    expect(s.statusCode, s.body).toBe(200);
    const rows = await getDb().select().from(notifications).where(eq(notifications.userId, IDS.user));
    const each = rows.filter((r) => r.kind === "BUDGET_EACH");
    expect(each.length).toBeGreaterThanOrEqual(2);
    for (const r of each) expect(r.body).toMatch(/^CN¥[\d,.]+ \(≈ KZT\s[\d,.]+\) at /);
    const fee = rows.find((r) => r.kind === "FEES_SETTLED")!;
    expect(fee.body.startsWith("Buy Everything Shop from China:")).toBe(true);
    for (const r of rows) expect(r.body).not.toMatch(/\b[a-z]+ shop in\b/);
    const x = await cardFees(IDS.user);
    expect(x.exampleValues).toBe(true);
  });

  it("DCC warnings carry a display name next to the key", async () => {
    await notify(IDS.user, {
      kind: "FEES_DCC",
      title: "t",
      body: "b",
      data: { transactionId: "00000000-0000-4000-8000-0000000000d1", cardId: null, merchantNorm: "coffee shop in", overMidBps: 500, params: { merchant: "Coffee Shop in Budapest" } },
    });
    const x = await cardFees(IDS.user);
    expect(x.dccWarnings[0]).toMatchObject({ merchantNorm: "coffee shop in", merchant: "Coffee Shop in Budapest" });
    const only = await getDb().select().from(notifications).where(and(eq(notifications.userId, IDS.user), eq(notifications.kind, "FEES_DCC")));
    expect(only).toHaveLength(1);
  });
});

describe("planner placeholders never reach the user's order (cn note 5)", () => {
  it("propose_order re-hydrates payee placeholders in purpose and item names before rules sees them", async () => {
    const { ports, log } = fakePorts();
    const redactor = new Redactor();
    const ref = redactor.placeholderFor("PAYEE", LANDLORD);
    const ctx: ToolContext = { ports, redactor, emit: () => undefined, readDocs: new Map(), stop: { requested: false, reason: null }, proposals: [] };
    const tools = buildTools(ctx);
    await (tools.propose_order as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(
      { payeeRef: ref, amountMinor: 18000000, currency: "HUF", purpose: `November rent for ${ref}` },
      { toolCallId: "t", messages: [] },
    );
    expect(log.proposeOrder[0]!.purpose).toBe("November rent for Kovács Péter");
  });
});
