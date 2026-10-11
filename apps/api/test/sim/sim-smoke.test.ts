/*
 * Smoke test for the sim CLI (scripts/sim): up → register (demo claim + onboarding) → planner tools →
 * propose → passkey approve → down, through real processes. Uses its own ports and state directory so it
 * never collides with a running `bun run sim` or `bun run dev`.
 */
import { isValidIban } from "@kassa/shared";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const CLI = fileURLToPath(new URL("../../scripts/sim/cli.ts", import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), "kassa-sim-smoke-"));
const PORTS = { SIM_API_PORT: "4190", SIM_MOCK_PORT: "4191", SIM_CONTROL_PORT: "4192" };

type Out = { code: number; json: Record<string, unknown> };

function sim(...args: string[]): Out {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // SIM_OWNER_PID: if this worker dies before afterAll (outer timeout, Ctrl-C), the daemon stops itself (Y7).
  Object.assign(env, PORTS, { SIM_DIR: DIR, SIM_EVIDENCE_DIR: join(DIR, "evidence"), SIM_OWNER_PID: String(process.pid) });
  const r = spawnSync("bun", [CLI, ...args], { cwd: REPO, env, encoding: "utf8", timeout: 150_000 });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    json = { unparsed: r.stdout, stderr: r.stderr };
  }
  return { code: r.status ?? -1, json };
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

afterAll(() => {
  sim("down");
  rmSync(DIR, { recursive: true, force: true });
});

describe("sim CLI smoke", () => {
  it("up → register → tools → propose → approve with passkey → down", async () => {
    const up = sim("up", "--fresh");
    expect(up.code, JSON.stringify(up.json)).toBe(0);
    expect(up.json.started).toBe(true);

    const reg = sim("register", "dana", "--claim-demo");
    expect(reg.code, JSON.stringify(reg.json)).toBe(0);
    expect((reg.json.onboarding as { baseRules: { onboarded: boolean } }).baseRules.onboarded).toBe(true);

    const bal = sim("tool", "get_balances", "{}", "--as", "dana");
    expect(bal.code, JSON.stringify(bal.json)).toBe(0);
    const balOut = bal.json.output as { homeCurrency: string; balances: unknown[] };
    expect(balOut.balances.length).toBeGreaterThan(0);

    const obs = sim("tool", "get_obligations", "{}", "--as", "dana");
    const list = (obs.json.output as { obligations: { payeeRef: string; payeeStatus: string; amountMinor: number; currency: string; homeAmountMinor: number }[] }).obligations;
    // The largest verified bill: above the small-auto limit, so rules ask for the passkey.
    const bill = list.filter((o) => o.payeeStatus === "VERIFIED").sort((a, b) => b.homeAmountMinor - a.homeAmountMinor)[0]!;
    expect(bill.payeeRef).toMatch(/^payee_\d+$/);
    // Tool outputs are redacted: no IBAN-shaped strings reach the planner (I11).
    const candidates = JSON.stringify(obs.json.output).match(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g) ?? [];
    // RF… = ISO 11649 creditor reference (same MOD 97 check, not a country code): allowed, it is not personal data.
    expect(candidates.filter((c) => !c.startsWith("RF") && isValidIban(c))).toEqual([]);

    // No single seeded balance covers the largest bill (rules would REFUSE INSUFFICIENT_FUNDS, B2): fund it first
    // (simulated money from home); the cheapest funding route is then the same-currency one.
    const top = sim("mock", "remittance", "--amount", String(Math.ceil(bill.amountMinor / 100) + 10), "--currency", bill.currency);
    expect(top.json.httpStatus).toBe(202);

    const prop = sim("tool", "propose_order", JSON.stringify({ payeeRef: bill.payeeRef, amountMinor: bill.amountMinor, currency: bill.currency, purpose: "sim smoke" }), "--as", "dana");
    const po = prop.json.output as { proposalId: string; decision: string };
    expect(po.decision, JSON.stringify(prop.json)).toBe("ASK");

    const order = sim("as", "dana", "order", po.proposalId);
    expect((order.json.data as { hashMatches: boolean }).hashMatches).toBe(true);

    const ap = sim("as", "dana", "approve", po.proposalId);
    expect(ap.code, JSON.stringify(ap.json)).toBe(0);
    const apd = ap.json.data as { tier: string; paymentStatus: string; approvalId: string };
    expect(apd.tier).toBe("T2");
    expect(apd.paymentStatus).toBe("PROCESSING");

    // Approving the same order again is refused (single use, I4).
    const again = sim("as", "dana", "approve", po.proposalId);
    expect(again.code).toBe(1);
    expect(again.json.error).toBe("NOT_PENDING");

    const lv = sim("ledger-verify");
    expect(lv.json.ok).toBe(true);

    const down = sim("down");
    expect(down.code).toBe(0);
    expect(down.json.portsFree).toBe(true);
    for (const p of Object.values(PORTS)) expect(await portOpen(Number(p))).toBe(false);
  }, 240_000);
});
