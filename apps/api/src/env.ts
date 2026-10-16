/*
 * Validated configuration (spec §20 + .env.example additions). Read once, lazily, via `env()`.
 *
 * Keys (scripts/keys-generate.ts format):
 * - Ed25519 private keys: base64 PKCS#8 DER; public keys: base64 SPKI DER (RFC 8410).
 * - ACCOUNT_ENC_KEY: 32 random bytes, base64 (AES-256-GCM, NIST SP 800-38D).
 * - USER_KEK: 32 random bytes, base64 — key-encryption key wrapping each user's data key (privacy/keys.ts).
 * Outside production, missing keys are generated once and persisted to <repo>/.data/dev-secrets.json
 * (gitignored) so `bun run dev` works without a .env AND survives restarts (payee ciphertexts, ledger
 * checkpoints and sessions stay valid). Tests use ephemeral values. Production refuses to start without them.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().optional(),
  PUBLIC_ORIGIN: z.string().url().default("http://localhost:8081"),
  /** Extra allowed WebAuthn origins (comma separated), e.g. the Expo dev server and native app origins. */
  EXTRA_ORIGINS: z.string().optional(),
  RP_ID: z.string().min(1).default("localhost"),
  RP_NAME: z.string().default("Kassa"),
  SESSION_SECRET: z.string().optional(),
  RULES_SIGNING_KEY: z.string().optional(),
  RULES_PUBLIC_KEY: z.string().optional(),
  LEDGER_CHECKPOINT_KEY: z.string().optional(),
  LEDGER_CHECKPOINT_PUBLIC_KEY: z.string().optional(),
  ACCOUNT_ENC_KEY: z.string().optional(),
  /** KEK for per-user data keys (GDPR Art. 17 crypto-shredding). Rotating it: scripts/rotate-kek.ts. */
  USER_KEK: z.string().optional(),
  /** During a KEK rotation only: the previous KEK, used to unwrap (never to wrap) until scripts/rotate-kek.ts ran. */
  USER_KEK_PREVIOUS: z.string().optional(),
  MOCK_HMAC_SECRET: z.string().optional(),
  AGENT_MODE: z.enum(["LIVE", "REPLAY"]).default("LIVE"),
  /** OpenRouter key for `openrouter:<model>` (ai/registry.ts). */
  OPENROUTER_API_KEY: z.string().optional(),
  /** Retries for 429 / 5xx model errors (ai/retry.ts: exponential backoff + jitter, honours Retry-After). */
  AI_MAX_RETRIES: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(0).max(20).default(5)),
  /** First structured-output mode to try (ai/structured.ts); unset = native, then auto fallback, cached per model. */
  AI_STRUCTURED_MODE: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["native", "tool", "json"]).optional()),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  ISSUING_PROVIDER: z.enum(["stripe", "fake"]).optional(),
  /** Stripe Issuing balance/card currency (EU accounts: EUR). Charges in other currencies are converted by Stripe. */
  STRIPE_ISSUING_CURRENCY: z.string().regex(/^[A-Z]{3}$/).default("EUR"),
  // Spec §20 example is ₸500,000, but the hero tuition (€2,400 ≈ ₸1.3–1.4M) would then always be refused
  // by payments (I5). Default ₸2,000,000; see docs/DECISIONS.md 2026-10-11.
  PAYMENTS_DAILY_CAP_HOME_MINOR: z.coerce.number().int().positive().default(200_000_000),
  // (cap currency) PAYMENTS_DAILY_CAP_HOME_MINOR is a fixed amount in this reference currency; each user gets it converted to
  // their home currency, rounded down, fail-closed. See docs/DECISIONS.md 2026-10-12.
  PAYMENTS_DAILY_CAP_CURRENCY: z.string().regex(/^[A-Z]{3}$/).default("KZT"),
  // (X3, security review F2) Per-day small-auto budget (T1 without a mandate): at most this many payments per UTC
  // day, and at most MULTIPLE × the signed small-auto limit in total. Beyond it: ASK SMALL_AUTO_BUDGET_EXHAUSTED.
  SMALL_AUTO_DAILY_MAX_COUNT: z.coerce.number().int().min(0).default(3),
  SMALL_AUTO_DAILY_AMOUNT_MULTIPLE: z.coerce.number().int().min(0).default(3),
  DEMO_ENABLED: bool,
  DEMO_ADMIN_TOKEN: z.string().optional(),
  /**
   * Dev sign-in without a passkey (POST /auth/dev/login, auth/dev.ts). Only with DEMO_ENABLED, never in production,
   * and only when RP_ID is localhost, a *.trycloudflare.com quick tunnel or PHONE_HOST.
   */
  DEV_LOGIN: bool,
  /** Stable phone host (named tunnel), e.g. kassa.example.com: the server URL KassaLite and the Shortcut use. */
  PHONE_HOST: z.string().optional(),
  MOCK_WORLD_URL: z.string().url().default("http://localhost:4001"),
  /** Where people open mock-world pages (school portals) from the app: mock-world's MOCK_PUBLIC_URL. */
  MOCK_PUBLIC_URL: z.string().url().default("http://localhost:4001"),
  /**
   * Wise sandbox (rails/bankApi.ts): with a sandbox API token the bank rail sends real sandbox quotes, recipients and
   * transfers instead of using mock-world. Never a live token: the URL defaults to the sandbox.
   */
  WISE_SANDBOX_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  WISE_API_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().default("https://api.sandbox.transferwise.tech")),
  WISE_PROFILE_ID: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().optional()),
  SCHEDULER_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v === undefined || v === "true" || v === "1"),
  /**
   * Fastify trustProxy: unset/false = use the socket address; "true" = trust X-Forwarded-For (only behind a
   * proxy that overwrites it, e.g. Caddy in docker-compose); a number = hops; otherwise comma-separated IPs/CIDRs.
   */
  TRUST_PROXY: z.string().optional(),
  /** Rate limits (requests per minute per client IP; @fastify/rate-limit, in memory). */
  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_SENSITIVE_PER_MIN: z.coerce.number().int().positive().default(30),
  /** Retention (days) for the purge job (GDPR Art. 5(1)(e) storage limitation); 0 = keep. */
  RETENTION_DAYS_NOTIFICATIONS: z.coerce.number().int().min(0).default(90),
  RETENTION_DAYS_PLACEHOLDER_MAPS: z.coerce.number().int().min(0).default(30),
  RETENTION_DAYS_DOCUMENTS: z.coerce.number().int().min(0).default(30),
  RETENTION_DAYS_CAPTURED_TEXT: z.coerce.number().int().min(0).default(90),
});

export type Env = z.infer<typeof EnvSchema> & {
  RULES_SIGNING_KEY: string;
  RULES_PUBLIC_KEY: string;
  LEDGER_CHECKPOINT_KEY: string;
  ACCOUNT_ENC_KEY: string;
  USER_KEK: string;
  SESSION_SECRET: string;
  MOCK_HMAC_SECRET: string;
  ISSUING_PROVIDER: "stripe" | "fake";
  /** All origins accepted for WebAuthn (PUBLIC_ORIGIN + EXTRA_ORIGINS). */
  origins: string[];
  stripeEnabled: boolean;
  /** Parsed TRUST_PROXY for Fastify. */
  trustProxy: boolean | string[] | ((address: string, hop: number) => boolean);
};

let cached: Env | null = null;
let overrides: Partial<Record<string, string>> = {};

function ed25519Pair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

export const DEV_MOCK_HMAC_SECRET = "dev-only-mock-hmac-secret-change-me";
const DEV_SECRETS_FILE = fileURLToPath(new URL("../../../.data/dev-secrets.json", import.meta.url));
const SECRET_KEYS = ["RULES_SIGNING_KEY", "RULES_PUBLIC_KEY", "LEDGER_CHECKPOINT_KEY", "ACCOUNT_ENC_KEY", "USER_KEK", "SESSION_SECRET", "MOCK_HMAC_SECRET"] as const;

/** Development only: fill missing secrets from (or into) .data/dev-secrets.json. */
function devSecrets(raw: Record<string, string | undefined>): Record<string, string> {
  if (raw.NODE_ENV === "production" || raw.NODE_ENV === "test" || process.env.VITEST) return {};
  if (SECRET_KEYS.every((k) => raw[k])) return {};
  let stored: Record<string, string> = {};
  try {
    if (existsSync(DEV_SECRETS_FILE)) stored = JSON.parse(readFileSync(DEV_SECRETS_FILE, "utf8")) as Record<string, string>;
  } catch {
    stored = {};
  }
  if (!stored.RULES_SIGNING_KEY) {
    const rules = ed25519Pair();
    const ledgerKey = ed25519Pair();
    stored = {
      RULES_SIGNING_KEY: rules.privateKey,
      RULES_PUBLIC_KEY: rules.publicKey,
      LEDGER_CHECKPOINT_KEY: ledgerKey.privateKey,
      ACCOUNT_ENC_KEY: randomBytes(32).toString("base64"),
      SESSION_SECRET: randomBytes(48).toString("base64url"),
      USER_KEK: randomBytes(32).toString("base64"),
    };
    try {
      mkdirSync(fileURLToPath(new URL("../../../.data/", import.meta.url)), { recursive: true });
      writeFileSync(DEV_SECRETS_FILE, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
      console.warn(`[env] generated development secrets in ${DEV_SECRETS_FILE} (not for production)`);
    } catch (err) {
      console.warn(`[env] could not persist dev secrets: ${(err as Error).message}`);
    }
  }
  if (!stored.USER_KEK) {
    // Older dev-secrets.json (before Phase 2): add the KEK once and persist it.
    stored.USER_KEK = randomBytes(32).toString("base64");
    try {
      writeFileSync(DEV_SECRETS_FILE, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    } catch (err) {
      console.warn(`[env] could not persist dev secrets: ${(err as Error).message}`);
    }
  }
  const out: Record<string, string> = {};
  // Keep key pairs consistent: only take the stored public key when the private key also comes from the file.
  for (const k of SECRET_KEYS) if (!raw[k] && stored[k]) out[k] = stored[k];
  if (raw.RULES_SIGNING_KEY) delete out.RULES_PUBLIC_KEY;
  // Must equal mock-world's development default (apps/mock-world/src/config.ts) so webhooks verify locally.
  if (!raw.MOCK_HMAC_SECRET) out.MOCK_HMAC_SECRET = DEV_MOCK_HMAC_SECRET;
  return out;
}

export function env(): Env {
  if (cached) return cached;
  const base = { ...process.env, ...overrides };
  const raw = { ...base, ...devSecrets(base) };
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  const prod = e.NODE_ENV === "production";
  const missing: string[] = [];
  const need = (name: keyof typeof e, make: () => string): string => {
    const v = e[name];
    if (typeof v === "string" && v.length > 0) return v;
    if (prod) throw new Error(`${name} is required in production (bun run keys:generate)`);
    missing.push(name);
    return make();
  };

  let rulesPublic = e.RULES_PUBLIC_KEY;
  let rulesPrivate = e.RULES_SIGNING_KEY;
  if (!rulesPrivate) {
    const pair = ed25519Pair();
    rulesPrivate = need("RULES_SIGNING_KEY", () => pair.privateKey);
    rulesPublic = pair.publicKey;
  }
  const ledgerKey = need("LEDGER_CHECKPOINT_KEY", () => ed25519Pair().privateKey);
  if (!rulesPublic) {
    if (prod) throw new Error("RULES_PUBLIC_KEY is required in production");
    missing.push("RULES_PUBLIC_KEY");
  }

  // Kassa never moves real money: a Wise URL must be a sandbox host.
  if (e.WISE_SANDBOX_TOKEN && !/sandbox/i.test(new URL(e.WISE_API_URL).hostname)) {
    throw new Error("WISE_API_URL must be a Wise sandbox host (e.g. https://api.sandbox.transferwise.tech)");
  }
  const stripeEnabled = Boolean(e.STRIPE_SECRET_KEY && e.STRIPE_SECRET_KEY.startsWith("sk_test_"));
  const result: Env = {
    ...e,
    RULES_SIGNING_KEY: rulesPrivate,
    // Derived lazily by rules/publicKey.ts when absent outside production.
    RULES_PUBLIC_KEY: rulesPublic ?? "",
    LEDGER_CHECKPOINT_KEY: ledgerKey,
    ACCOUNT_ENC_KEY: need("ACCOUNT_ENC_KEY", () => randomBytes(32).toString("base64")),
    USER_KEK: need("USER_KEK", () => randomBytes(32).toString("base64")),
    SESSION_SECRET: need("SESSION_SECRET", () => randomBytes(48).toString("base64url")),
    MOCK_HMAC_SECRET: need("MOCK_HMAC_SECRET", () => (e.NODE_ENV === "test" ? "test-mock-hmac-secret" : randomBytes(32).toString("base64url"))),
    // Default to fake issuing when Stripe test keys are absent (spec §11 FakeIssuing fallback).
    ISSUING_PROVIDER: e.ISSUING_PROVIDER === "stripe" && stripeEnabled ? "stripe" : "fake",
    origins: [e.PUBLIC_ORIGIN, ...(e.EXTRA_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [])],
    stripeEnabled,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
  };
  if (prod && e.DEMO_ENABLED && (e.DEMO_ADMIN_TOKEN ?? "").length < 32) {
    // Demo admin routes move the clock and reset data: never open, never guessable in production.
    throw new Error("DEMO_ENABLED in production requires DEMO_ADMIN_TOKEN of at least 32 characters (bun run env:setup)");
  }
  if (missing.length > 0 && e.NODE_ENV !== "test") {
    console.warn(`[env] using ephemeral values for: ${missing.join(", ")} (not for production)`);
  }
  cached = result;
  return result;
}

function parseTrustProxy(v: string | undefined): Env["trustProxy"] {
  const t = v?.trim();
  if (!t || t === "false" || t === "0") return false;
  if (t === "true") return true;
  if (/^\d+$/.test(t)) {
    const hops = Number(t);
    return (_address: string, hop: number) => hop < hops; // trust the nearest N proxies
  }
  return t.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Tests: override variables and drop the cache. */
export function setEnvForTests(values: Partial<Record<string, string>>): void {
  overrides = { ...overrides, ...values };
  cached = null;
}

export function resetEnvCache(): void {
  overrides = {};
  cached = null;
}
