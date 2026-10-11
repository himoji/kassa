#!/usr/bin/env bun
/**
 * `bun run env:setup` - keep the env files in sync with what the code reads.
 *
 * 1. Adds missing keys to `.env.example` and `apps/mobile/.env.example` (and applies the
 *    documented value changes listed in EXAMPLE_OVERRIDES). Existing lines are kept.
 * 2. Creates or completes `.env` (repo root) for local, Docker-free dev: generates every secret
 *    that is missing or empty, derives public keys from private keys, and writes dev defaults.
 *    Values already present are never changed.
 * 3. Links `apps/api/.env` and `apps/mock-world/.env` to the root `.env` (bun loads `.env` from
 *    the cwd, and both services must share MOCK_HMAC_SECRET), and writes `apps/mobile/.env`.
 *
 * Secret values are never printed; only key names are reported. `.env` files are gitignored.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

type Entry = { key: string; example: string; comment?: string };

/** Keys the code reads that the root example may not have yet (api, mock-world, AI layer). */
const ROOT_KEYS: Entry[] = [
  { key: "DATABASE_URL", example: "", comment: "optional; unset = file-backed PGlite at ./.data/kassa (no Docker needed); postgres://… for real Postgres" },
  { key: "PUBLIC_ORIGIN", example: "http://localhost:8081", comment: "WebAuthn origin" },
  { key: "RP_ID", example: "localhost" },
  { key: "RP_NAME", example: "Kassa" },
  { key: "EXTRA_ORIGINS", example: "", comment: "comma-separated extra WebAuthn origins" },
  { key: "SESSION_SECRET", example: "" },
  { key: "RULES_SIGNING_KEY", example: "", comment: "Ed25519 private (base64 PKCS#8 DER)" },
  { key: "RULES_PUBLIC_KEY", example: "", comment: "given to payments" },
  { key: "LEDGER_CHECKPOINT_KEY", example: "" },
  { key: "LEDGER_CHECKPOINT_PUBLIC_KEY", example: "", comment: "optional; derived from LEDGER_CHECKPOINT_KEY when unset" },
  { key: "ACCOUNT_ENC_KEY", example: "", comment: "AES-256-GCM for payee account details" },
  { key: "USER_KEK", example: "", comment: "AES-256-GCM key-encryption key for per-user data keys (GDPR erasure = crypto-shredding)" },
  { key: "MOCK_HMAC_SECRET", example: "" },
  { key: "ANTHROPIC_API_KEY", example: "" },
  { key: "OPENAI_API_KEY", example: "" },
  { key: "GOOGLE_GENERATIVE_AI_API_KEY", example: "" },
  { key: "LOCAL_BASE_URL", example: "http://localhost:11434/v1", comment: "OpenAI-compatible local endpoint (Ollama, LM Studio)" },
  { key: "LOCAL_API_KEY", example: "" },
  { key: "LOCAL_VISION", example: "false", comment: "set true if the local model accepts images" },
  { key: "PLANNER_MODEL", example: "anthropic:claude-sonnet-5-5", comment: "provider:model — anthropic | openai | google | local" },
  { key: "READER_MODEL", example: "anthropic:claude-haiku-5-5" },
  { key: "AGENT_MODE", example: "LIVE", comment: "or REPLAY (recorded tool calls, no API key needed)" },
  { key: "RECORD", example: "", comment: "1 = record live agent runs to fixtures/agent-recordings" },
  { key: "FX_OFFLINE", example: "", comment: "1 = use fixtures/fx-rates.json example rates (no network)" },
  { key: "STRIPE_SECRET_KEY", example: "sk_test_..." },
  { key: "STRIPE_WEBHOOK_SECRET", example: "whsec_..." },
  { key: "STRIPE_PUBLISHABLE_KEY", example: "pk_test_..." },
  { key: "STRIPE_ISSUING_CURRENCY", example: "", comment: "currency of the Stripe Issuing balance (e.g. EUR)" },
  { key: "ISSUING_PROVIDER", example: "fake", comment: "stripe | fake (fake is used whenever Stripe keys are absent)" },
  { key: "PAYMENTS_DAILY_CAP_HOME_MINOR", example: "200000000", comment: "₸2,000,000 — see docs/DECISIONS.md (spec's ₸500,000 refuses the hero tuition)" },
  { key: "PAYMENTS_DAILY_CAP_CURRENCY", example: "KZT", comment: "reference currency of PAYMENTS_DAILY_CAP_HOME_MINOR" },
  { key: "SMALL_AUTO_DAILY_MAX_COUNT", example: "3", comment: "small-auto (T1 without mandate) payments per UTC day; then ASK SMALL_AUTO_BUDGET_EXHAUSTED" },
  { key: "SMALL_AUTO_DAILY_AMOUNT_MULTIPLE", example: "3", comment: "small-auto total per day = this × the signed small-auto limit" },
  { key: "SCHEDULER_ENABLED", example: "true" },
  { key: "DEMO_ENABLED", example: "true" },
  { key: "DEMO_ADMIN_TOKEN", example: "" },
  { key: "MOCK_WORLD_URL", example: "http://localhost:4001", comment: "API → mock-world" },
  { key: "API_URL", example: "http://localhost:4000", comment: "mock-world → API" },
  { key: "MOCK_PUBLIC_URL", example: "http://localhost:4001", comment: "public base URL of mock-world pages" },
  { key: "MOCK_BANK_STEP_SECONDS", example: "", comment: "optional; demo-clock seconds per mock transfer state" },
  { key: "MOCK_BANK_TICK_MS", example: "", comment: "optional; mock bank status tick interval" },
  { key: "TRUST_PROXY", example: "", comment: "unset = socket address; true behind a proxy that overwrites X-Forwarded-For (docker-compose Caddy); or IP/CIDR list" },
  { key: "RATE_LIMIT_GLOBAL_PER_MIN", example: "600", comment: "requests per minute per IP, all routes" },
  { key: "RATE_LIMIT_AUTH_PER_MIN", example: "20", comment: "auth options/verify, refresh, public verify" },
  { key: "RATE_LIMIT_SENSITIVE_PER_MIN", example: "30", comment: "order approve, capture shortcut, privacy, unfreeze" },
  { key: "RETENTION_DAYS_NOTIFICATIONS", example: "90", comment: "purge job; 0 = keep" },
  { key: "RETENTION_DAYS_PLACEHOLDER_MAPS", example: "30", comment: "agent conversations + placeholder maps" },
  { key: "RETENTION_DAYS_DOCUMENTS", example: "30", comment: "uploaded documents (invoices, screenshots)" },
  { key: "RETENTION_DAYS_CAPTURED_TEXT", example: "90", comment: "raw merchant text of captured purchases" },
];

/** Example values that were deliberately changed (docs/DECISIONS.md). */
const EXAMPLE_OVERRIDES: Record<string, string> = { PAYMENTS_DAILY_CAP_HOME_MINOR: "200000000" };

const MOBILE_KEYS: Entry[] = [
  { key: "EXPO_PUBLIC_API_URL", example: "http://localhost:4000", comment: "API origin; the client appends /api" },
  { key: "EXPO_PUBLIC_DEMO_ADMIN_TOKEN", example: "", comment: "dev/demo only — same value as DEMO_ADMIN_TOKEN" },
];

/** Dev values written into `.env` when the key is missing or empty (no Docker, no AI keys). */
const DEV_DEFAULTS: Record<string, string> = {
  PUBLIC_ORIGIN: "http://localhost:8081",
  RP_ID: "localhost",
  RP_NAME: "Kassa",
  AGENT_MODE: "REPLAY",
  ISSUING_PROVIDER: "fake",
  PAYMENTS_DAILY_CAP_HOME_MINOR: "200000000",
  SCHEDULER_ENABLED: "true",
  DEMO_ENABLED: "true",
  MOCK_WORLD_URL: "http://localhost:4001",
  API_URL: "http://localhost:4000",
  MOCK_PUBLIC_URL: "http://localhost:4001",
  PLANNER_MODEL: "anthropic:claude-sonnet-5-5",
  READER_MODEL: "anthropic:claude-haiku-5-5",
  LOCAL_BASE_URL: "http://localhost:11434/v1",
  RATE_LIMIT_GLOBAL_PER_MIN: "600",
  RATE_LIMIT_AUTH_PER_MIN: "20",
  RATE_LIMIT_SENSITIVE_PER_MIN: "30",
  RETENTION_DAYS_NOTIFICATIONS: "90",
  RETENTION_DAYS_PLACEHOLDER_MAPS: "30",
  RETENTION_DAYS_DOCUMENTS: "30",
  RETENTION_DAYS_CAPTURED_TEXT: "90",
};

const b64url = (n: number) => randomBytes(n).toString("base64url");
const SECRET_GENERATORS: Record<string, () => string> = {
  SESSION_SECRET: () => b64url(48),
  ACCOUNT_ENC_KEY: () => randomBytes(32).toString("base64"),
  USER_KEK: () => randomBytes(32).toString("base64"),
  MOCK_HMAC_SECRET: () => b64url(32),
  DEMO_ADMIN_TOKEN: () => b64url(24),
};

// ---------- tiny .env parser that preserves lines ----------
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function read(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").replace(/\n$/, "").split("\n") : [];
}
function parse(lines: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of lines) {
    const hit = LINE.exec(l);
    if (hit) m.set(hit[1]!, hit[2]!.replace(/\s+#.*$/, "").trim().replace(/^(['"])(.*)\1$/, "$2"));
  }
  return m;
}
function setValue(lines: string[], key: string, value: string): boolean {
  const i = lines.findIndex((l) => LINE.exec(l)?.[1] === key);
  if (i === -1) return false;
  const comment = / #.*$/.exec(lines[i]!.split("=").slice(1).join("="))?.[0] ?? "";
  lines[i] = `${key}=${value}${comment ? ` ${comment.trim()}` : ""}`;
  return true;
}
const fmt = (e: Entry, value: string) => (e.comment ? `${e.key}=${value} # ${e.comment}` : `${e.key}=${value}`);

// ---------- 1. examples ----------
function syncExample(path: string, entries: Entry[], overrides: Record<string, string> = {}) {
  const lines = read(path);
  const have = parse(lines);
  const added: string[] = [];
  const changed: string[] = [];
  for (const [k, v] of Object.entries(overrides)) if (have.has(k) && have.get(k) !== v && setValue(lines, k, v)) changed.push(k);
  const missing = entries.filter((e) => !have.has(e.key));
  if (missing.length) {
    lines.push("", "# --- added by bun run env:setup ---");
    for (const e of missing) {
      lines.push(fmt(e, e.example));
      added.push(e.key);
    }
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  return { added, changed };
}

// ---------- 2. root .env ----------
function ed25519() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
}
function publicFrom(privB64: string) {
  const priv = createPrivateKey({ key: Buffer.from(privB64, "base64"), format: "der", type: "pkcs8" });
  return createPublicKey(priv).export({ format: "der", type: "spki" }).toString("base64");
}

function syncDotenv(path: string) {
  const lines = read(path);
  if (!lines.length) lines.push("# Local dev env - generated by bun run env:setup. Never commit.");
  const have = parse(lines);
  const filled: string[] = [];
  const put = (key: string, value: string) => {
    if (!setValue(lines, key, value)) lines.push(`${key}=${value}`);
    have.set(key, value);
    filled.push(key);
  };
  const empty = (k: string) => !have.get(k);

  for (const [k, gen] of Object.entries(SECRET_GENERATORS)) if (empty(k)) put(k, gen());
  if (empty("RULES_SIGNING_KEY")) {
    put("RULES_SIGNING_KEY", ed25519());
    put("RULES_PUBLIC_KEY", publicFrom(have.get("RULES_SIGNING_KEY")!));
  } else if (empty("RULES_PUBLIC_KEY")) put("RULES_PUBLIC_KEY", publicFrom(have.get("RULES_SIGNING_KEY")!));
  if (empty("LEDGER_CHECKPOINT_KEY")) put("LEDGER_CHECKPOINT_KEY", ed25519());
  if (empty("LEDGER_CHECKPOINT_PUBLIC_KEY")) put("LEDGER_CHECKPOINT_PUBLIC_KEY", publicFrom(have.get("LEDGER_CHECKPOINT_KEY")!));
  for (const [k, v] of Object.entries(DEV_DEFAULTS)) if (empty(k)) put(k, v);

  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  return { filled, demoToken: have.get("DEMO_ADMIN_TOKEN")! };
}

// ---------- 3. per-app env ----------
function link(app: string) {
  const p = join(root, app, ".env");
  let exists = false;
  try {
    lstatSync(p);
    exists = true;
  } catch {}
  if (exists) return `${app}/.env exists (left as is)`;
  symlinkSync("../../.env", p);
  return `${app}/.env → ../../.env`;
}

function syncMobileEnv(demoToken: string) {
  const path = join(root, "apps/mobile/.env");
  const lines = read(path);
  const have = parse(lines);
  const filled: string[] = [];
  const want: Record<string, string> = { EXPO_PUBLIC_API_URL: "http://localhost:4000", EXPO_PUBLIC_DEMO_ADMIN_TOKEN: demoToken };
  for (const [k, v] of Object.entries(want)) {
    if (have.get(k)) continue;
    if (!setValue(lines, k, v)) lines.push(`${k}=${v}`);
    filled.push(k);
  }
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  return filled;
}

const ex = syncExample(join(root, ".env.example"), ROOT_KEYS, EXAMPLE_OVERRIDES);
const mex = syncExample(join(root, "apps/mobile/.env.example"), MOBILE_KEYS);
const env = syncDotenv(join(root, ".env"));
const links = ["apps/api", "apps/mock-world"].map(link);
const mob = syncMobileEnv(env.demoToken);

const list = (xs: string[]) => (xs.length ? xs.join(", ") : "nothing");
console.log(`.env.example: added ${list(ex.added)}; updated ${list(ex.changed)}`);
console.log(`apps/mobile/.env.example: added ${list(mex.added)}`);
console.log(`.env: filled ${list(env.filled)} (values not shown)`);
for (const l of links) console.log(l);
console.log(`apps/mobile/.env: filled ${list(mob)}`);
