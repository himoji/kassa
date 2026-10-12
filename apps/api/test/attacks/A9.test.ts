/*
 * A9 (Business M5): "new bank details" supplier invoice. A newer supplier (B in Budapest, D in Shanghai) sends an
 * invoice for the established supplier's signed purchase order, in that supplier's name, asking to be paid to its
 * own account (B's IBAN / D's QR-wallet merchant). The three-way match refuses it (INVOICE_ACCOUNT_MISMATCH):
 * ledgered, owner notified, no obligation, no proposal, no payment. The genuine invoice afterwards still matches.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUSINESS_IDS, SEED_NOW } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { ledgerEntries, notifications, obligations, payments, proposals } from "../../src/db/schema.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { wireExecutor } from "../../src/modules/orders/wiring.ts";
import { setRailOverridesForTests } from "../../src/modules/rails/index.ts";
import { useTestApp } from "../helpers/app.ts";
import { draftBoxes, ownerPasskey, poRow, portal, signPo } from "../helpers/business.ts";
import { useTestDb } from "../helpers/db.ts";
import { offlineEnvironment } from "../helpers/fixtures.ts";
import { deliverWebhooks, startMockWorld, type TestMockWorld } from "../helpers/mockWorld.ts";

const t = useTestDb();
const app = useTestApp();
let mw: TestMockWorld;

beforeEach(async () => {
  await t.reset();
  clock.freezeForTests(new Date(SEED_NOW));
  offlineEnvironment();
  setRailOverridesForTests({});
  wireExecutor();
  mw = await startMockWorld({ env: { DEMO_ENABLED: "true" }, api: app });
  await seedDatabase(getDb(), await loadSeedData(), { reset: true, personas: true });
});
afterEach(async () => {
  clock.freezeForTests(null);
  await mw.close();
});

const CASES = [
  { slug: "bud" as const, home: "HUF", supplier: "a", attacker: "b", payee: BUSINESS_IDS.bud.payees.supplierA, packs: 1 },
  { slug: "sha" as const, home: "CNY", supplier: "c", attacker: "d", payee: BUSINESS_IDS.sha.payees.supplierC, packs: 4 },
];

describe("A9 swapped bank details on a supplier invoice", () => {
  for (const c of CASES) {
    it(`${c.slug}: supplier ${c.attacker} invoices ${c.supplier}'s PO with its own account → refused`, async () => {
      const userId = BUSINESS_IDS[c.slug].user;
      const auth = await ownerPasskey(userId, c.home);
      const poId = await draftBoxes(c.slug, c.payee, c.packs);
      expect((await signPo(app(), userId, auth, poId)).statusCode).toBe(200);
      await portal(mw, app(), c.supplier, poId, "confirm");

      // The attacker's portal lists the target's orders and has the attack button.
      const page = await mw.app.inject({ method: "GET", url: `/mock/supplier/${c.attacker}/portal` });
      expect(page.body).toContain("swapped bank details");
      const atk = await mw.app.inject({ method: "POST", url: `/mock/supplier/${c.attacker}/attack/swapped-invoice`, payload: { purchaseOrderId: poId } });
      expect(atk.statusCode, atk.body).toBe(200);
      const out = await deliverWebhooks(mw, app());
      expect(out.map((d) => d.statusCode)).toEqual([200]);
      expect(out[0]!.json).toMatchObject({ matched: true, refused: true, reasonCodes: ["INVOICE_ACCOUNT_MISMATCH"] });

      const po = await poRow(poId);
      expect(po).toMatchObject({ status: "CONFIRMED", obligationId: null, proposalId: null, invoice: null });
      expect(po.reasonCodes).toContain("INVOICE_ACCOUNT_MISMATCH");
      expect(await getDb().select().from(obligations).where(eq(obligations.userId, userId))).toHaveLength(0);
      expect(await getDb().select().from(proposals)).toHaveLength(0);
      expect(await getDb().select().from(payments)).toHaveLength(0);
      const refused = await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "INVOICE_REFUSED"));
      expect(refused).toHaveLength(1);
      const notes = await getDb().select().from(notifications).where(eq(notifications.kind, "BUSINESS_INVOICE_REFUSED"));
      expect(notes.map((n) => n.userId)).toEqual([userId]);

      // The genuine supplier's invoice still matches and is proposed.
      await portal(mw, app(), c.supplier, poId, "invoice");
      expect((await poRow(poId)).status).toBe("INVOICED");
      expect(await getDb().select().from(proposals)).toHaveLength(1);
    });
  }
});
