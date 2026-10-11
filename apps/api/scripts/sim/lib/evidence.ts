/*
 * Evidence for scenario runs: `mark <name>` remembers the ledger head + demo time; `evidence <scenario>`
 * dumps everything since a marker to docs/evidence/sim/<scenario>.json; `report` appends one row to
 * docs/evidence/sim/SUMMARY.md; `ledger-verify` runs the ledger chain check.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { alive } from "./lifecycle.ts";
import { API_DIR, type DaemonState, ensureDir, EVIDENCE_DIR, FILES, readJson, REPO_ROOT, writeJson } from "./config.ts";
import { control } from "./http.ts";
import { fail } from "./out.ts";

type Marker = { seq: number; at: string; createdAt: string };
type Markers = Record<string, Marker>;

const SCENARIO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function scenarioName(s: string | undefined): string {
  if (!s || !SCENARIO_RE.test(s)) fail("BAD_ARGS", `scenario id must match ${SCENARIO_RE}`);
  return s;
}

export async function mark(name: string) {
  const n = scenarioName(name);
  const head = await control<{ seq: number; now: string }>("/ledger-head");
  const markers = readJson<Markers>(FILES.markers) ?? {};
  markers[n] = { seq: head.seq, at: head.now, createdAt: new Date().toISOString() };
  writeJson(FILES.markers, markers);
  return { marker: n, ...markers[n] };
}

export async function evidence(scenario: string, opts: { since?: string }) {
  const s = scenarioName(scenario);
  const markers = readJson<Markers>(FILES.markers) ?? {};
  const m = markers[opts.since ?? s];
  if (opts.since && !m) fail("UNKNOWN_MARKER", `no marker "${opts.since}" (run: sim mark ${opts.since})`);
  const dump = await control<Record<string, unknown>>("/evidence", { sinceSeq: m?.seq ?? 0, sinceAt: m?.at ?? new Date(0).toISOString() });
  ensureDir(EVIDENCE_DIR);
  const file = resolve(EVIDENCE_DIR, `${s}.json`);
  writeFileSync(file, `${JSON.stringify({ scenario: s, marker: m ?? null, ...dump }, null, 2)}\n`);
  const counts = {
    ledger: (dump.ledger as unknown[]).length,
    proposals: (dump.proposals as unknown[]).length,
    payments: (dump.payments as unknown[]).length,
    notifications: (dump.notifications as unknown[]).length,
  };
  return { written: file, marker: m ?? null, counts, ledgerVerify: dump.ledgerVerify };
}

const cell = (s: string) => s.replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();

export function report(scenario: string, opts: { result: string; notes: string }) {
  const s = scenarioName(scenario);
  const r = opts.result.toUpperCase();
  if (r !== "PASS" && r !== "FAIL") fail("BAD_ARGS", "--result must be PASS or FAIL");
  ensureDir(EVIDENCE_DIR);
  const summary = resolve(EVIDENCE_DIR, "SUMMARY.md");
  if (!existsSync(summary)) {
    writeFileSync(summary, "# Sim scenario results\n\nOne row per run, appended by `bun run sim report`.\n\n| Scenario | Result | Run at (UTC) | Evidence | Notes |\n| --- | --- | --- | --- | --- |\n");
  }
  const links = [`${s}.md`, `${s}.json`].filter((f) => existsSync(resolve(EVIDENCE_DIR, f))).map((f) => `[${f}](${f})`);
  const notes = cell(opts.notes);
  const row = `| ${s} | ${r} | ${new Date().toISOString()} | ${links.join(" ") || "-"} | ${notes.length > 400 ? `${notes.slice(0, 397)}...` : notes || "-"} |\n`;
  appendFileSync(summary, row);
  return { appended: summary, row: row.trim() };
}

/**
 * Daemon up: the same ledger.verify() the script calls, in the process that owns the DB.
 * Daemon down: the real `bun run ledger:verify` script against the sim database.
 */
export async function ledgerVerify() {
  const state = readJson<DaemonState>(FILES.state);
  if (state && alive(state.daemonPid)) {
    const report = await control<{ ok: boolean }>("/ledger-verify");
    ensureDir(EVIDENCE_DIR);
    writeJson(resolve(EVIDENCE_DIR, "ledger-verify.json"), report, 0o644);
    return { via: "daemon (ledger.verify, same function as scripts/ledger-verify.ts)", ...report };
  }
  if (!existsSync(FILES.db)) fail("NO_SIM_DB", "no sim database yet; run: bun run sim up");
  // The script always writes docs/evidence/ledger-verify.json (the product's evidence file): keep that file
  // as it was and store the sim's report under docs/evidence/sim/ instead.
  const mainEvidence = resolve(REPO_ROOT, "docs/evidence/ledger-verify.json");
  const saved = existsSync(mainEvidence) ? readFileSync(mainEvidence) : null;
  const r = spawnSync(process.execPath, ["scripts/ledger-verify.ts"], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: `pglite://${FILES.db}` },
    encoding: "utf8",
  });
  if (saved) writeFileSync(mainEvidence, saved);
  else rmSync(mainEvidence, { force: true });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = { stdout: r.stdout.slice(-4000) };
  }
  ensureDir(EVIDENCE_DIR);
  writeJson(resolve(EVIDENCE_DIR, "ledger-verify.json"), parsed, 0o644);
  if (r.status !== 0) fail("LEDGER_VERIFY_FAILED", "ledger verification failed", { exitCode: r.status, report: parsed, stderr: r.stderr.slice(-2000) });
  return { via: "scripts/ledger-verify.ts", exitCode: r.status, report: parsed };
}
