import { z } from "zod";

/*
 * Environment for the mock world (spec §17, §20). Everything here is simulated; no real money or
 * real bank APIs. Stripe is used only in test mode and only with an `sk_test_` key.
 */

const Env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  HOST: z.string().default("0.0.0.0"),
  /** Base URL of the Kassa API (no trailing slash), e.g. http://api:4000. */
  API_URL: z.string().url().default("http://localhost:4000"),
  /** Public base URL of this service, used in links (payUrl, invoice URLs). */
  MOCK_PUBLIC_URL: z.string().url().default("http://localhost:4001"),
  MOCK_HMAC_SECRET: z.string().optional(),
  ISSUING_PROVIDER: z.enum(["stripe", "fake"]).default("fake"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_API_BASE: z.string().url().default("https://api.stripe.com"),
  /** Demo-clock seconds between mock bank transfer states after funding. */
  MOCK_BANK_STEP_SECONDS: z.coerce.number().int().min(1).max(86_400).default(20),
  /** Real-time interval at which the mock bank re-reads the demo clock and advances transfers. */
  MOCK_BANK_TICK_MS: z.coerce.number().int().min(200).max(60_000).default(2000),
  /** Demo Stage (/mock/stage) and its server-side actions exist only when the demo is on (same flag as the API). */
  DEMO_ENABLED: z.enum(["true", "false", "1", "0", ""]).default("false"),
  /** Sent to the API's demo admin routes by the stage server. Never rendered into a page. */
  DEMO_ADMIN_TOKEN: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  NODE_ENV: z.string().default("development"),
});

export interface MockWorldConfig {
  port: number;
  host: string;
  apiUrl: string;
  publicUrl: string;
  hmacSecret: string;
  issuingProvider: "stripe" | "fake";
  stripeSecretKey: string | null;
  stripeApiBase: string;
  bankStepMs: number;
  bankTickMs: number;
  logLevel: string;
  demoEnabled: boolean;
  demoAdminToken: string | null;
}

const DEV_SECRET = "dev-only-mock-hmac-secret-change-me";

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MockWorldConfig {
  const e = Env.parse(env);
  const production = e.NODE_ENV === "production";
  if (!e.MOCK_HMAC_SECRET && production) {
    throw new Error("MOCK_HMAC_SECRET is required in production (webhooks must be authenticated, I13)");
  }
  if (e.ISSUING_PROVIDER === "stripe" && !e.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
    throw new Error("ISSUING_PROVIDER=stripe needs a test-mode STRIPE_SECRET_KEY (sk_test_...)");
  }
  return {
    port: e.PORT,
    host: e.HOST,
    apiUrl: trimSlash(e.API_URL),
    publicUrl: trimSlash(e.MOCK_PUBLIC_URL),
    hmacSecret: e.MOCK_HMAC_SECRET || DEV_SECRET,
    issuingProvider: e.ISSUING_PROVIDER,
    stripeSecretKey: e.STRIPE_SECRET_KEY ?? null,
    stripeApiBase: trimSlash(e.STRIPE_API_BASE),
    bankStepMs: e.MOCK_BANK_STEP_SECONDS * 1000,
    bankTickMs: e.MOCK_BANK_TICK_MS,
    logLevel: e.LOG_LEVEL,
    demoEnabled: e.DEMO_ENABLED === "true" || e.DEMO_ENABLED === "1",
    demoAdminToken: e.DEMO_ADMIN_TOKEN || null,
  };
}

export function usingDevSecret(cfg: MockWorldConfig): boolean {
  return cfg.hmacSecret === DEV_SECRET;
}
