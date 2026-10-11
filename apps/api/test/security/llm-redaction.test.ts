/*
 * I11 end to end on the seeded demo user: everything the PLANNER model receives in a multi-tool turn
 * (system prompt, user text, every tool result, including a document's Reader output) carries no IBAN, PAN,
 * email, phone number, payee name or user name. The Reader itself legitimately receives raw document text
 * (I10 quarantine: no tools, no memory, schema output) — documented in docs/PRIVACY.md — so this test covers
 * what crosses into the planner. PCI DSS scope: no full PAN column exists and capture parsers keep last4 only.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import type { MockLanguageModelV4 } from "ai/test";
import { beforeAll, describe, expect, it } from "vitest";

import { formatIbanPrint } from "@kassa/shared";
import { getDb } from "../../src/db/client.ts";
import { payees, users } from "../../src/db/schema.ts";
import { agentDocuments } from "../../src/db/schema.intel.ts";
import { startTurn } from "../../src/modules/agent/loop.ts";
import { dbPorts } from "../../src/modules/agent/ports.ts";
import { replayModel, type RecordedStep } from "../../src/modules/agent/replay.ts";
import { dbTurnStore } from "../../src/modules/agent/store.ts";
import { ingestCapture } from "../../src/modules/capture/index.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { decryptAccount } from "../../src/modules/payees/crypto.ts";
import { useTestDb } from "../helpers/db.ts";
import { offlineEnvironment } from "../helpers/fixtures.ts";
import { drain } from "../intel/fakes.ts";
import { ensureIntelTables } from "../intel/intelTables.ts";

const t = useTestDb();
const PAN = "4111111111111111";
const EMAIL = "dana.private@example.org";
const PHONE = "+36 30 123 4567";

let userId = "";
let displayName = "";
let names: string[] = [];
let ibans: string[] = [];

beforeAll(async () => {
  await ensureIntelTables(t.db());
  offlineEnvironment();
  ({ userId } = await seedDatabase(getDb(), await loadSeedData(), { reset: false }));
  displayName = (await getDb().select().from(users).where(eq(users.id, userId)))[0]!.displayName;
  const rows = await getDb().select().from(payees).where(eq(payees.userId, userId));
  names = rows.map((p) => p.name);
  ibans = rows.map((p) => decryptAccount(userId, p.accountEnc)).filter((a) => /^[A-Z]{2}\d{2}/.test(a));
  expect(names.length).toBeGreaterThan(1);
  expect(ibans.length).toBeGreaterThan(0);
});

describe("I11: the planner prompt for a seeded conversation contains no personal data", () => {
  it("covers user text, every read tool and a document's Reader output", async () => {
    const conversationId = randomUUID();
    const landlordIban = ibans[0]!;
    const docId = (
      await getDb()
        .insert(agentDocuments)
        .values({
          userId,
          conversationId,
          mediaType: "text/plain",
          dataB64: Buffer.from("x").toString("base64"),
          kind: "invoice",
          createdAt: clock.now(),
          // Cached Reader result whose fields quote personal data verbatim (as a real invoice would).
          readerResult: {
            kind: "invoice",
            fields: {
              payeeName: { value: names[0], evidence: names[0], check: "VERIFIED" },
              account: { value: formatIbanPrint(landlordIban), evidence: formatIbanPrint(landlordIban), check: "VERIFIED" },
              contact: { value: `${EMAIL} / ${PHONE}`, evidence: EMAIL, check: "UNVERIFIED" },
            },
            parsed: { amountMinor: 18_000_000, currency: "HUF", account: landlordIban },
            checks: { nonCriticalUnverified: true, fields: {}, failures: {} },
            reasonCodes: [],
            sourceKind: "text",
            model: "replay",
          },
        })
        .returning({ id: agentDocuments.id })
    )[0]!.id;
    await ingestCapture(userId, { source: "TEXT", fields: { merchant: `${names[0]} deposit`, amountMinor: 1000, currency: "HUF" } });

    const steps: RecordedStep[] = [
      { toolCalls: [{ toolName: "get_profile_summary", input: {} }] },
      { toolCalls: [{ toolName: "get_obligations", input: {} }] },
      { toolCalls: [{ toolName: "get_payee_facts", input: { payeeRef: "payee_1" } }] },
      { toolCalls: [{ toolName: "get_balances", input: {} }] },
      { toolCalls: [{ toolName: "get_budget", input: {} }] },
      { toolCalls: [{ toolName: "read_document", input: { docId } }] },
      { toolCalls: [{ toolName: "forecast_coverage", input: {} }] },
      { text: "Here is what I found about payee_1." },
    ];
    const model = replayModel({ userText: "x", match: [], steps }) as unknown as MockLanguageModelV4;
    const text = `Hi, ${displayName} here. Pay ${names.join(" and ")} to ${formatIbanPrint(landlordIban)} or ${landlordIban}; my card is ${PAN.replace(/(\d{4})(?=\d)/g, "$1 ")}, email ${EMAIL}, phone ${PHONE}.`;
    const h = await startTurn({ ports: dbPorts(userId, conversationId), store: dbTurnStore(conversationId, userId), text, mode: "LIVE", model, emit: () => undefined });
    await drain(h.uiStream);
    const summary = await h.done;
    expect(summary.toolCalls.map((c) => c.toolName)).toContain("read_document");

    const prompts = JSON.stringify(model.doStreamCalls.map((c) => c.prompt));
    expect(model.doStreamCalls.length).toBeGreaterThanOrEqual(steps.length);
    const forbidden = [
      displayName,
      ...names,
      ...ibans,
      ...ibans.map((i) => formatIbanPrint(i)),
      PAN,
      PAN.replace(/(\d{4})(?=\d)/g, "$1 "),
      EMAIL,
      PHONE,
      PHONE.replace(/\s/g, ""),
    ];
    for (const f of forbidden) expect(prompts, `planner saw "${f}"`).not.toContain(f);
    expect(prompts).toMatch(/payee_\d/);
    expect(prompts).toMatch(/iban_\d/);
  });
});

describe("PCI DSS scope reduction: no full PAN is ever stored", () => {
  const schemaDir = fileURLToPath(new URL("../../src/db/", import.meta.url));
  const migDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));

  it("no column in any migration can hold a full card number (only last4)", () => {
    const sqlText = readdirSync(migDir).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(join(migDir, f), "utf8")).join("\n");
    const columns = [...sqlText.matchAll(/"([a-z0-9_]+)" (?:text|varchar|bigint|integer|numeric|jsonb|uuid|timestamp|boolean|date|double)/g)].map((m) => m[1]!);
    expect(columns.length).toBeGreaterThan(100);
    expect(columns).toContain("last4");
    expect(columns.filter((c) => /(^|_)(pan|card_?num(ber)?|card_?no|cvv|cvc|cvv2|track_?data|primary_account)(_|$)/.test(c))).toEqual([]);
    // Drizzle schema property names too (the TS side of the same columns).
    const ts = readdirSync(schemaDir).filter((f) => f.startsWith("schema")).map((f) => readFileSync(join(schemaDir, f), "utf8")).join("\n");
    expect(ts).not.toMatch(/\b(pan|cardNumber|cardNo|cvv|cvc|trackData)\s*:/);
  });

  it("capture keeps at most the last 4 digits of a card number found in notification text", async () => {
    // (the I11 test above already put a CARD placeholder for this PAN into placeholder_maps)
    const raw = `Purchase 4 760 HUF at MARKET HALL, card ${PAN.slice(0, 4)} ${PAN.slice(4, 8)} ${PAN.slice(8, 12)} ${PAN.slice(12)}. Balance 100 000 KZT`;
    await ingestCapture(userId, { source: "NOTIF_SIM", rawText: raw });
    await ingestCapture(userId, { source: "TEXT", fields: { merchant: "Shop", amountMinor: 100, currency: "HUF", cardHint: PAN } });
    const tables = (await getDb().execute(sql`select tablename from pg_tables where schemaname = 'public'`)) as unknown as { rows: { tablename: string }[] };
    let all = "";
    for (const { tablename } of tables.rows) {
      const r = (await getDb().execute(sql.raw(`select row_to_json(x)::text as j from "${tablename}" x`))) as unknown as { rows: { j: string }[] };
      all += r.rows.map((x) => x.j).join("\n");
    }
    expect(all).not.toContain(PAN);
    expect(all).not.toMatch(/4111[ -]?1111[ -]?1111[ -]?1111/);
  });
});
