import { randomUUID } from "node:crypto";

import type { UIMessageChunk } from "ai";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proposals, transactions, users, webauthnCredentialsPayments, webauthnCredentialsRules } from "../../src/db/schema.ts";
import { startTurn } from "../../src/modules/agent/loop.ts";
import { dbPorts } from "../../src/modules/agent/ports.ts";
import { loadRecording, selectTurn } from "../../src/modules/agent/replay.ts";
import { dbTurnStore } from "../../src/modules/agent/store.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { getDb } from "../../src/db/client.ts";
import { useTestDb } from "../helpers/db.ts";
import { offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { SoftAuthenticator } from "../helpers/webauthn.ts";
import { IDS, LI_WEI_IDS } from "../../../../fixtures/seed-data.ts";
import { drain } from "./fakes.ts";
import { ensureIntelTables } from "./intelTables.ts";

const t = useTestDb();

beforeAll(async () => {
  await ensureIntelTables(t.db());
});

beforeEach(async () => {
  await t.reset();
  offlineEnvironment();
  const data = await loadSeedData();
  await seedDatabase(getDb(), data, { reset: true, personas: true });
  for (const [userId, homeCurrency] of [
    [IDS.user, "KZT"],
    [LI_WEI_IDS.user, "CNY"],
  ] as const) {
    const auth = new SoftAuthenticator();
    const row = { userId, credentialId: auth.id, publicKey: auth.publicKeyB64u(), counter: 0, transports: ["internal"] };
    await getDb().insert(webauthnCredentialsRules).values(row);
    await getDb().insert(webauthnCredentialsPayments).values(row);
    await signBaseRules(userId, auth, homeCurrency);
  }
});

async function turn(userId: string, text: string) {
  const conversationId = randomUUID();
  const emitted: UIMessageChunk[] = [];
  const h = await startTurn({
    ports: dbPorts(userId, conversationId),
    store: dbTurnStore(conversationId, userId),
    text,
    mode: "REPLAY",
    emit: (c) => emitted.push(c),
    replayChunkDelayMs: 0,
  });
  await drain(h.uiStream);
  return await h.done;
}

describe("CN demo recordings (REPLAY, no API key)", () => {
  it("the three CN recordings parse and are selectable by keyword", () => {
    expect(loadRecording("cn-shanghai-handoff")).not.toBeNull();
    expect(loadRecording("cn-spending")).not.toBeNull();
    expect(loadRecording("cn-li-wei")).not.toBeNull();
    expect(selectTurn("Pay the payee_1 my November dorm fee").recording.scenario).toBe("cn-shanghai-handoff");
    expect(selectTurn("buy a BEDDING set from payee_1 for ¥349").recording.scenario).toBe("cn-shanghai-handoff");
    expect(selectTurn("I just paid ¥28 for the metro in Shanghai").recording.scenario).toBe("cn-spending");
    expect(selectTurn("please pay my tuition from my yuan").recording.scenario).toBe("cn-li-wei");
    expect(selectTurn("please pay the TUITION now").recording.scenario).toBe("tuition");
  });

  it("D-CN1: with region CN the dorm fee turn proposes ¥1,800 to the dorm office and rules decide HANDOFF", async () => {
    await getDb().update(users).set({ region: "CN" }).where(eq(users.id, IDS.user));
    const s = await turn(IDS.user, "Pay the Dorm Office in Shanghai my November dorm fee");
    expect(s.toolCalls.map((c) => c.toolName)).toEqual(["get_obligations", "get_routes", "get_routes", "forecast_coverage", "propose_order"]);
    const rows = await getDb().select().from(proposals).where(eq(proposals.userId, IDS.user));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ createdBy: "AGENT", decision: "HANDOFF" });
    expect(rows[0]!.reasonCodes).toEqual(["HANDOFF_REGION"]);
    expect(rows[0]!.draft).toMatchObject({ payeeId: IDS.payees.dormOffice, amountMinor: 180000, currency: "CNY" });
    expect(rows[0]!.canonicalOrder).toMatchObject({ rail: "HANDOFF", currency: "CNY", amountMinor: 180000, payeeName: "Dorm Office in Shanghai", homeCurrency: "KZT" });
  });

  it("D-CN1: the bedding turn proposes ¥349 to the shop (HANDOFF)", async () => {
    await getDb().update(users).set({ region: "CN" }).where(eq(users.id, IDS.user));
    const s = await turn(IDS.user, "Buy a bedding set from Buy Everything Shop from China for ¥349");
    expect(s.toolCalls.map((c) => c.toolName)).toEqual(["propose_order"]);
    const rows = await getDb().select().from(proposals).where(eq(proposals.userId, IDS.user));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: "HANDOFF", draft: { payeeId: IDS.payees.cnShop, amountMinor: 34900, currency: "CNY" } });
  });

  it("D-CN2: the metro turn only logs (no proposal)", async () => {
    const s = await turn(IDS.user, "I just paid ¥28 for the metro in Shanghai");
    expect(s.toolCalls.map((c) => c.toolName)).toEqual(["log_expense", "get_budget"]);
    expect(await getDb().select().from(proposals).where(eq(proposals.userId, IDS.user))).toHaveLength(0);
    const rows = await getDb().select().from(transactions).where(eq(transactions.userId, IDS.user));
    expect(rows.find((r) => r.currency === "CNY" && r.amountMinor === 2800 && r.category === "transport")).toBeDefined();
  });

  it("D-CN3: Li Wei's tuition turn proposes €3,200 to his university and rules ASK", async () => {
    const s = await turn(LI_WEI_IDS.user, "Pay my tuition from my yuan");
    expect(s.toolCalls.map((c) => c.toolName)).toEqual(["get_obligations", "get_routes", "forecast_coverage", "propose_order"]);
    const rows = await getDb().select().from(proposals).where(eq(proposals.userId, LI_WEI_IDS.user));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.draft).toMatchObject({ payeeId: LI_WEI_IDS.payees.university, amountMinor: 320000, currency: "EUR" });
    expect(["ASK", "REFUSE"]).toContain(rows[0]!.decision);
    expect(await getDb().select().from(proposals).where(eq(proposals.userId, IDS.user))).toHaveLength(0);
  });
});
