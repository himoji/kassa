/*
 * Invariant index (spec §2, §19 "Invariant tests: I1–I13"). One describe per invariant with at least one
 * concrete check; the deeper suites are referenced in each block's comment and in docs/security/self-assessment.md §3.
 */
import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import { buildIban, formatIbanPrint, orderHash } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { approvals, ledgerEntries, payments, profiles, proposals } from "../../src/db/schema.ts";
import { setEnvForTests } from "../../src/env.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { Redactor, type KnownName } from "../../src/modules/agent/redact.ts";
import { createPayee } from "../../src/modules/payees/service.ts";
import { executeApproval } from "../../src/modules/payments/index.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { loadSanctions, setSanctionsListForTests } from "../../src/modules/screening/index.ts";
import { verifyExtraction } from "../../src/modules/reader/reader.ts";
import { ledger } from "../../src/modules/ledger/index.ts";
import { ledgerOf, ledgerWithReason } from "../helpers/attacks.ts";
import { forgeSignedApproval } from "../helpers/forge.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { addPayee, createUserWithPasskey, IBAN_OTHER, IBAN_UNIVERSITY, offlineEnvironment } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";
import { postSignedWebhook } from "../helpers/mockWorld.ts";
import { API_ROOT, closure, pathTo, sourceFiles } from "../helpers/importGraph.ts";

const t = useTestDb();
const app = useTestApp();

describe("I1 the agent has no payment capability (transitive import graph)", () => {
  const agentFiles = sourceFiles(`${API_ROOT}/src/modules/agent`);
  const g = closure(agentFiles);
  const rel = (f: string) => relative(API_ROOT, f).replaceAll("\\", "/");

  it("scans the whole agent module and what it reaches at runtime", () => {
    expect(agentFiles.length).toBeGreaterThanOrEqual(10);
    // The scan really follows edges: agent → rules (proposeOrder) is reached.
    expect([...g.keys()].map(rel)).toContain("src/modules/rules/index.ts");
  });

  it("nothing reachable from agent/** is in payments/** or rails/**", () => {
    const bad = [...g.keys()].filter((f) => /^src\/modules\/(payments|rails)\//.test(rel(f)));
    expect(bad.map((f) => pathTo(g, f))).toEqual([]);
  });

  it("ledger/internal is reached only through the ledger facade (ledger/index.ts), never imported directly", () => {
    const internal = [...g.keys()].find((f) => rel(f) === "src/modules/ledger/internal.ts");
    const importers = [...g.entries()].filter(([, n]) => internal !== undefined && n.imports.includes(internal)).map(([f]) => rel(f));
    expect(importers.every((f) => f === "src/modules/ledger/index.ts")).toBe(true);
    for (const f of agentFiles) expect(g.get(f)!.imports.map(rel), rel(f)).not.toContain("src/modules/ledger/internal.ts");
  });

  it("the scanner would catch a violation (rules/facts no longer reaches rails/mockBank since the wallet reader is wired)", () => {
    const wiring = closure([`${API_ROOT}/src/modules/orders/wiring.ts`]);
    expect([...wiring.keys()].map(rel)).toEqual(expect.arrayContaining(["src/modules/payments/index.ts", "src/modules/rails/mockBank.ts"]));
    expect([...g.keys()].map(rel)).not.toContain("src/modules/orders/wiring.ts");
  });
});

describe("I2 Payments execute only signed approvals", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  // Deeper: test/core/payments.test.ts (signature, nonce, expiry, tampered order), test/attacks/A3.test.ts.
  it("no approval → NO_APPROVAL, one PAYMENT_REFUSED entry, no payment", async () => {
    const r = await executeApproval(randomUUID());
    expect(r.reasonCodes).toEqual(["NO_APPROVAL"]);
    expect(await ledgerWithReason("PAYMENT_REFUSED", "NO_APPROVAL")).toHaveLength(1);
    expect(await getDb().select().from(payments)).toHaveLength(0);
  });
});

describe("I3 What is signed is the canonical order", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  // Deeper: test/attacks/A8.test.ts (lying confirmation), test/core/payments.test.ts (ORDER_HASH_MISMATCH).
  it("the passkey challenge is the hash of the stored canonical order", async () => {
    const { userId } = await createUserWithPasskey();
    const payee = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY });
    const p = await proposeOrder({ userId, createdBy: "AGENT", payeeId: payee.id, amountMinor: 10_000, currency: "EUR", purpose: "Tuition" });
    expect(p.decision).toBe("ASK");
    const view = await getOrderView(userId, p.proposalId);
    expect(view.webauthnOptions!.challenge).toBe(view.orderHash);
    expect(view.orderHash).toBe(orderHash(view.canonicalOrder));
  });
});

describe("I4 Single use", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  // Deeper: test/core/payments.test.ts (NONCE_USED on re-execution), test/attacks/A3.test.ts (replay).
  it("re-executing an executed approval → NONCE_USED, still one payment", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const payee = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY });
    const p = await proposeOrder({ userId, createdBy: "AGENT", payeeId: payee.id, amountMinor: 10_000, currency: "EUR", purpose: "Tuition" });
    const view = await getOrderView(userId, p.proposalId);
    const res = await approveOrder(userId, p.proposalId, auth.assert(view.orderHash));
    expect(res.paymentStatus).toBe("PROCESSING");
    const replay = await executeApproval(res.approvalId);
    expect(replay.reasonCodes).toEqual(["NONCE_USED"]);
    expect(await getDb().select().from(payments)).toHaveLength(1);
  });
});

describe("I5 Independent cap", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  // Deeper: test/core/payments.test.ts ("enforces its own daily cap … across currencies (I5, X2)"), test/core/payments-cap.test.ts.
  it("payments refuses an order over its own daily cap (PAYMENTS_DAILY_CAP) in the home currency across currencies, even when a rules bug signs it", async () => {
    setEnvForTests({ PAYMENTS_DAILY_CAP_HOME_MINOR: "150000000" }); // ₸1.5M; €2,400 ≈ ₸1.344M; HUF 180,000 ≈ ₸259,200
    try {
      const { userId, auth } = await createUserWithPasskey();
      const university = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY });
      const landlord = await addPayee(userId, { name: "Landlord in Budapest", kind: "LANDLORD", currency: "HUF" });
      // Both proposed before anything is paid: rules see no usage and offer both for signing.
      const first = await proposeOrder({ userId, createdBy: "AGENT", payeeId: university.id, amountMinor: 240_000, currency: "EUR", purpose: "Tuition" });
      const second = await proposeOrder({ userId, createdBy: "AGENT", payeeId: landlord.id, amountMinor: 18_000_000, currency: "HUF", purpose: "Rent" });
      expect(second.decision).toBe("ASK");
      const v1 = await getOrderView(userId, first.proposalId);
      const v2 = await getOrderView(userId, second.proposalId);
      expect((await approveOrder(userId, first.proposalId, auth.assert(v1.orderHash))).paymentStatus).toBe("PROCESSING");
      // (2026-10-18) rules re-check the caps at approval, counting the payment just made: refused before signing.
      await expect(approveOrder(userId, second.proposalId, auth.assert(v2.orderHash))).rejects.toMatchObject({ status: 409, code: "REFUSE_CAP" });
      // A rules logic bug that signs it anyway: payments' own cap (I5) still refuses, nothing is paid.
      const forged = await forgeSignedApproval(landlord, { amountMinor: 18_000_000, currency: "HUF", homeAmountMinor: 25_920_000, tier: "T2", sign: (h) => auth.assert(h) });
      expect((await executeApproval(forged.approvalId)).reasonCodes).toEqual(["PAYMENTS_DAILY_CAP"]);
      expect(await getDb().select().from(payments)).toHaveLength(1);
    } finally {
      setEnvForTests({ PAYMENTS_DAILY_CAP_HOME_MINOR: "200000000" });
    }
  });
});

describe("I6 Triggers never approve", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  // Deeper: test/security/webhook-replay.test.ts (signed-delivery handling; the trigger path only logs).
  it("a signed POS trigger is logged as TRIGGER_POS and creates no proposal, approval or payment", async () => {
    const res = await postSignedWebhook(app(), "pos", { sku: "DOUGH-250G-40", level: 1, requestedQuantity: 400 });
    expect(res.statusCode).toBe(200);
    expect(await ledgerOf("TRIGGER_POS")).toHaveLength(1);
    expect(await getDb().select().from(proposals)).toHaveLength(0);
    expect(await getDb().select().from(approvals)).toHaveLength(0);
    expect(await getDb().select().from(payments)).toHaveLength(0);
  });
});

describe("I7 A payee change is a new payee", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  // Deeper: test/attacks/A1.test.ts (planner cannot pay a cooling payee), test/core/payees-mandates.test.ts (cooling, confirmation of payee).
  it("a new payee is COOLING for 24 h (demo clock) and a proposal to it is refused as unverified", async () => {
    const { userId } = await createUserWithPasskey();
    clock.freezeForTests(new Date("2026-10-11T09:00:00.000Z"));
    try {
      const payee = await createPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", account: IBAN_UNIVERSITY, country: "HU", currency: "EUR" });
      expect(payee.status).toBe("COOLING");
      expect(payee.coolingUntil!.getTime()).toBe(clock.nowMs() + 24 * 3_600_000);
      const p = await proposeOrder({ userId, createdBy: "AGENT", payeeId: payee.id, amountMinor: 10_000, currency: "EUR", purpose: "Tuition" });
      expect(p.decision).toBe("REFUSE");
      expect(p.reasonCodes).toContain("REFUSE_UNVERIFIED_PAYEE");
    } finally {
      clock.freezeForTests(null);
    }
  });
});

describe("I8 Loosening is slow, tightening is instant", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  const capsOf = async (userId: string) => (await getDb().select().from(profiles).where(eq(profiles.userId, userId)))[0]!.caps!;

  // Deeper: test/attacks/A4.test.ts (caps apply on the passkey, preset loosenings wait 24 h, signature reuse).
  it("raising perPaymentMinor without a passkey → 428 PASSKEY_REQUIRED, unchanged; lowering applies at once", async () => {
    const { userId } = await createUserWithPasskey();
    const before = await capsOf(userId);
    const up = await app().inject({ method: "PATCH", url: "/api/settings", headers: await bearer(userId), payload: { caps: { perPaymentMinor: before.perPaymentMinor * 2 } } });
    expect(up.statusCode).toBe(428);
    expect(up.json()).toMatchObject({ code: "PASSKEY_REQUIRED" });
    expect(await capsOf(userId)).toEqual(before);

    const down = await app().inject({ method: "PATCH", url: "/api/settings", headers: await bearer(userId), payload: { caps: { perPaymentMinor: before.perPaymentMinor - 100 } } });
    expect(down.statusCode).toBe(200);
    expect(down.json().pending).toEqual([]);
    expect((await capsOf(userId)).perPaymentMinor).toBe(before.perPaymentMinor - 100);
  });
});

describe("I9 Screening before outgoing transfers", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  // Deeper: test/attacks/A6.test.ts (transliteration, fuzzy, legal suffix), test/screening/screening.test.ts.
  it("a bank transfer to a transliterated sanctioned name → REFUSE_SANCTIONS", async () => {
    setSanctionsListForTests(loadSanctions());
    const { userId } = await createUserWithPasskey();
    const payee = await addPayee(userId, { name: "Svyatoslav Kassov", kind: "PERSON", account: IBAN_OTHER, currency: "HUF" });
    const p = await proposeOrder({ userId, createdBy: "AGENT", payeeId: payee.id, amountMinor: 1_000_000, currency: "HUF", purpose: "transfer", rail: "BANK_TRANSFER" });
    expect(p.decision).toBe("REFUSE");
    expect(p.reasonCodes).toEqual(["REFUSE_SANCTIONS"]);
  });
});

describe("I10 Untrusted content goes through the Reader only", () => {
  // Deeper: test/intel/reader.test.ts (evidence checks, MOD 97 check digits), test/attacks/A1.test.ts (hijacked Reader).
  const IBAN = buildIban("HU", "117730161111101800000000");
  const PRINTED = formatIbanPrint(IBAN);
  const SOURCE = `Budapest University of Technology (sample)\nPayee account: ${PRINTED}\nReference: RF39RUB2026F04217\nAmount due: €2,400.00\nDue date: 31.10.2026`;
  const f = (value: string | null, evidence: string | null) => ({ value, evidence });
  const good = {
    payeeName: f("Budapest University of Technology", "Budapest University of Technology (sample)"),
    accountNumber: f(IBAN, `Payee account: ${PRINTED}`),
    reference: f("RF39RUB2026F04217", "Reference: RF39RUB2026F04217"),
    amount: f("2400.00", "Amount due: €2,400.00"),
    currency: f("EUR", "€2,400.00"),
    dueDate: f("2026-10-31", "Due date: 31.10.2026"),
  };

  it("an amount whose evidence is not in the source is UNVERIFIED (READER_SOURCE_MISMATCH), while the faithful one is VERIFIED", () => {
    expect(verifyExtraction("invoice", good, SOURCE, "text", "t").checks.amount).toBe("VERIFIED");
    const r = verifyExtraction("invoice", { ...good, amount: f("9999.00", "Amount due: €9,999.00") }, SOURCE, "text", "t");
    expect(r.checks.amount).toBe("UNVERIFIED");
    expect(r.checks.failures.amount).toMatch(/not found in source/);
    expect(r.parsed.amountMinor).toBeUndefined();
    expect(r.reasonCodes).toContain("READER_SOURCE_MISMATCH");
  });
});

describe("I11 Personal data is reduced before planner calls", () => {
  // Deeper: test/intel/redact.test.ts (detectors, stable placeholders, rehydration), test/security/llm-redaction.test.ts.
  it("an IBAN and a known person's name become placeholders; the originals never appear", () => {
    const IBAN = buildIban("HU", "117730161111101800000000");
    const names: KnownName[] = [{ name: "Dana Nurlanovna", kind: "PERSON", ref: "Dana Nurlanovna", personal: true }];
    const out = new Redactor({ names }).redactText(`Dana Nurlanovna pays from ${formatIbanPrint(IBAN)}`);
    expect(out).toContain("iban_1");
    expect(out).toContain("person_1");
    for (const secret of ["Dana", "Nurlanovna", IBAN, formatIbanPrint(IBAN)]) expect(out).not.toContain(secret);
  });
});

describe("I12 Append-only ledger", () => {
  beforeEach(async () => {
    await t.reset();
  });

  // Deeper: test/core/ledger.test.ts (signed checkpoints, forged re-hash, deleted entry, concurrent appends).
  it("a verified chain reports ok; altering one stored payload makes verify report a hash mismatch", async () => {
    for (let i = 1; i <= 3; i++) await ledger.append("E", { i });
    expect((await ledger.verify()).ok).toBe(true);
    await getDb().update(ledgerEntries).set({ payload: { i: 999 } }).where(eq(ledgerEntries.seq, 2));
    const report = await ledger.verify();
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.seq === 2 && /hash mismatch/.test(p.problem))).toBe(true);
  });
});

describe("I13 Webhooks are authenticated", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  // Deeper: test/security/webhook-replay.test.ts (5-minute window, replay ledgering, bank state sequences).
  it("unsigned POST → 401; the signed delivery → 200; the same signed delivery again → 409 WEBHOOK_REPLAYED", async () => {
    const body = { sku: "DOUGH-250G-40", level: 1, requestedQuantity: 400 };
    const unsigned = await app().inject({ method: "POST", url: "/api/webhooks/mock/pos", payload: JSON.stringify(body), headers: { "content-type": "application/json" } });
    expect(unsigned.statusCode).toBe(401);

    const ts = Math.floor(clock.nowMs() / 1000);
    expect((await postSignedWebhook(app(), "pos", body, ts)).statusCode).toBe(200);
    const replay = await postSignedWebhook(app(), "pos", body, ts);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ code: "WEBHOOK_REPLAYED" });
  });
});
