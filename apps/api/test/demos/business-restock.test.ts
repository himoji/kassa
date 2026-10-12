/*
 * (Business M5) "Will we run out of anything tomorrow?" → "Order boxes from the usual supplier", the Shanghai owner,
 * REPLAY (business-restock.json) against the real tools, DB and in-process mock-world catalog: the forecast finds the
 * box shortage and the agent drafts ONE DRAFT purchase order at the supplier's catalog price. No proposal, approval or
 * payment exists afterwards (the PO tools never move money).
 */
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUSINESS_IDS, SEED_NOW } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { approvals, payments, proposals, purchaseOrders } from "../../src/db/schema.ts";
import { startTurn } from "../../src/modules/agent/loop.ts";
import { dbPorts } from "../../src/modules/agent/ports.ts";
import { loadRecording } from "../../src/modules/agent/replay.ts";
import { dbTurnStore } from "../../src/modules/agent/store.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { useTestDb } from "../helpers/db.ts";
import { offlineEnvironment } from "../helpers/fixtures.ts";
import { startMockWorld, stubCatalogFetch, type TestMockWorld } from "../helpers/mockWorld.ts";
import { drain } from "../intel/fakes.ts";
import { ensureIntelTables } from "../intel/intelTables.ts";

const t = useTestDb();
let mw: TestMockWorld;

beforeEach(async () => {
  await t.reset();
  await ensureIntelTables(t.db());
  clock.freezeForTests(new Date(SEED_NOW));
  offlineEnvironment();
  mw = await startMockWorld();
  stubCatalogFetch(mw);
  await seedDatabase(getDb(), await loadSeedData(), { reset: true, personas: true });
});
afterEach(async () => {
  clock.freezeForTests(null);
  await mw.close();
});

describe("business restock (M5, replay)", () => {
  it("the recording parses", () => {
    expect(loadRecording("business-restock")?.turns.map((x) => x.userText)).toEqual(["Will we run out of anything tomorrow?", "Order boxes from the usual supplier"]);
  });

  it("forecast → draft PO from the verified supplier at the catalog price; nothing payable is created", async () => {
    const userId = BUSINESS_IDS.sha.user;
    const conversationId = randomUUID();
    const turn = async (text: string) => {
      const h = await startTurn({ ports: dbPorts(userId, conversationId), store: dbTurnStore(conversationId, userId), text, mode: "REPLAY", emit: () => undefined, replayChunkDelayMs: 0 });
      await drain(h.uiStream);
      return h.done;
    };
    const t1 = await turn("Will we run out of anything tomorrow?");
    expect(t1.toolCalls.map((c) => c.toolName)).toEqual(["get_inventory", "forecast_stock"]);
    const t2 = await turn("Order boxes from the usual supplier");
    expect(t2.toolCalls.map((c) => c.toolName)).toEqual(["propose_purchase_order"]);

    const pos = await getDb().select().from(purchaseOrders);
    expect(pos).toHaveLength(1);
    expect(pos[0]).toMatchObject({ merchantId: BUSINESS_IDS.sha.merchant, supplierPayeeId: BUSINESS_IDS.sha.payees.supplierC, status: "DRAFT", createdBy: "AGENT", totalMinor: 72_000, currency: "CNY", reasonCodes: [] });
    expect(await getDb().select().from(proposals)).toHaveLength(0);
    expect(await getDb().select().from(approvals)).toHaveLength(0);
    expect(await getDb().select().from(payments)).toHaveLength(0);
  });
});
