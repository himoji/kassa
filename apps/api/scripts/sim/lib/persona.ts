/*
 * Personas: one file per persona in .data/sim/personas/<name>.json holding the session tokens and the
 * persona's software passkey (the "user's finger": an ES256 key that signs WebAuthn assertions, reused
 * from the API test helpers so the server runs its real signature / challenge / origin / UV checks).
 *
 * Each persona also gets a stable simulated client IP (X-Forwarded-For; the daemon runs the API with
 * TRUST_PROXY=true like the production Caddy setup) so parallel personas do not share one rate-limit bucket.
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { SoftAuthenticator } from "../../../test/helpers/webauthn.ts";
import { type DaemonState, FILES, readJson, writeJson } from "./config.ts";
import { apiRequestRaw, codeOf, type HttpResult, problemOf, withRateLimitRetry } from "./http.ts";
import { fail } from "./out.ts";

export type PersonaFile = {
  name: string;
  userId: string;
  displayName: string;
  createdAt: string;
  clientIp: string;
  /** Default planner conversation for `tool` calls. */
  conversationId: string;
  credential: { privateKeyPkcs8: string; credentialId: string; counter: number };
  tokens: { accessToken: string; refreshToken: string; accessTokenExpiresAt: string } | null;
  /** Assertions this persona submitted per proposal (for replay attacks). */
  lastAssertions: Record<string, unknown>;
};

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function personaPath(name: string): string {
  if (!NAME_RE.test(name)) fail("BAD_ARGS", `persona name must match ${NAME_RE} (got "${name}")`);
  return resolve(FILES.personas, `${name}.json`);
}

export function loadPersona(name: string): PersonaFile {
  const p = readJson<PersonaFile>(personaPath(name));
  if (!p) fail("UNKNOWN_PERSONA", `persona "${name}" not registered; run: bun run sim register ${name}`);
  return p;
}

export function savePersona(p: PersonaFile): void {
  writeJson(personaPath(p.name), p);
}

export function listPersonas(): string[] {
  try {
    return readdirSync(FILES.personas)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

export function authenticatorOf(p: PersonaFile): SoftAuthenticator {
  return new SoftAuthenticator(p.credential);
}

/** Stable per-persona IP in 10.77.0.0/16 (TEST-NET style private range; never routed). */
export function personaIp(name: string): string {
  const h = createHash("sha256").update(name).digest();
  return `10.77.${h[0]}.${(h[1]! % 253) + 1}`;
}

function daemonState(): DaemonState {
  const s = readJson<DaemonState>(FILES.state);
  if (!s) fail("SIM_DOWN", "sim is not running; run: bun run sim up");
  return s;
}

/** Sign `challenge` with the persona's passkey, as the browser would for this RP/origin. */
export function assertWith(auth: SoftAuthenticator, challenge: string, opts: { uv?: boolean; rpId?: string } = {}) {
  const s = daemonState();
  return auth.assert(challenge, { origin: s.origin, rpId: opts.rpId ?? s.rpId, ...(opts.uv === false ? { uv: false } : {}) });
}

type SessionBody = { user: { id: string; displayName: string }; onboarded: boolean; tokens: PersonaFile["tokens"] };

function ensureOk(r: HttpResult, what: string): void {
  if (r.status >= 400) {
    const p = problemOf(r);
    fail(codeOf(r) ?? `HTTP_${r.status}`, `${what}: ${p.detail ?? p.title ?? r.status}`, { httpStatus: r.status, reasonCodes: p.reasonCodes ?? [], body: r.body });
  }
}

/** Register a new passkey user (or claim the seeded demo user) and store the persona. */
/** `claimDemo`: true = the seeded hero (Dana); a string = that seeded demo persona (e.g. "li-wei"). */
export async function registerPersona(name: string, opts: { claimDemo: boolean | string; force: boolean; aiConsent: boolean }): Promise<{ persona: PersonaFile; session: SessionBody }> {
  const existing = readJson<PersonaFile>(personaPath(name));
  if (existing && !opts.force) fail("PERSONA_EXISTS", `persona "${name}" already exists (use --force to replace, or: sim login ${name})`);
  const s = daemonState();
  const ip = personaIp(name);
  const auth = new SoftAuthenticator();
  const headers = { "x-forwarded-for": ip };
  const o = await withRateLimitRetry(() =>
    apiRequestRaw("POST", "/auth/register/options", { body: { displayName: name, ...(opts.claimDemo ? { demoClaim: opts.claimDemo } : {}) }, headers }),
  );
  ensureOk(o, "register/options");
  const ob = o.body as { challengeId: string; options: { challenge: string; rp?: { id?: string } } };
  const response = auth.register(ob.options.challenge, { origin: s.origin, rpId: ob.options.rp?.id ?? s.rpId });
  const v = await withRateLimitRetry(() =>
    apiRequestRaw("POST", "/auth/register/verify", {
      body: { challengeId: ob.challengeId, response, client: "native", ...(opts.aiConsent ? { aiConsent: true } : {}) },
      headers,
    }),
  );
  ensureOk(v, "register/verify");
  const session = v.body as SessionBody;
  const persona: PersonaFile = {
    name,
    userId: session.user.id,
    displayName: session.user.displayName,
    createdAt: new Date().toISOString(),
    clientIp: ip,
    conversationId: randomUUID(),
    credential: auth.export(),
    tokens: session.tokens,
    lastAssertions: {},
  };
  savePersona(persona);
  return { persona, session };
}

/** Passkey sign-in (discoverable credential) → fresh native tokens. */
export async function loginPersona(p: PersonaFile): Promise<SessionBody> {
  const headers = { "x-forwarded-for": p.clientIp };
  const o = await withRateLimitRetry(() => apiRequestRaw("POST", "/auth/login/options", { headers }));
  ensureOk(o, "login/options");
  const ob = o.body as { challengeId: string; options: { challenge: string; rpId?: string } };
  const auth = authenticatorOf(p);
  const response = assertWith(auth, ob.options.challenge, ob.options.rpId ? { rpId: ob.options.rpId } : {});
  const v = await withRateLimitRetry(() => apiRequestRaw("POST", "/auth/login/verify", { body: { challengeId: ob.challengeId, response, client: "native" }, headers }));
  ensureOk(v, "login/verify");
  const session = v.body as SessionBody;
  p.tokens = session.tokens;
  p.credential = auth.export();
  savePersona(p);
  return session;
}

async function refresh(p: PersonaFile): Promise<boolean> {
  if (!p.tokens?.refreshToken) return false;
  const r = await withRateLimitRetry(() =>
    apiRequestRaw("POST", "/auth/refresh", { body: { refreshToken: p.tokens!.refreshToken }, headers: { "x-forwarded-for": p.clientIp } }),
  );
  if (r.status !== 200) return false;
  const t = r.body as { accessToken: string; refreshToken: string; accessTokenExpiresAt: string };
  p.tokens = { accessToken: t.accessToken, refreshToken: t.refreshToken, accessTokenExpiresAt: t.accessTokenExpiresAt };
  savePersona(p);
  return true;
}

export type PersonaRequestOpts = {
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  /** Default true: retry 429 with Retry-After. */
  rateLimitRetry?: boolean;
};

/** Authenticated API call as a persona with 401 / 429 / AI-consent handling. */
export async function personaRequest(p: PersonaFile, method: string, path: string, opts: PersonaRequestOpts = {}): Promise<HttpResult> {
  const send = () => {
    const headers: Record<string, string> = { "x-forwarded-for": p.clientIp, ...(opts.headers ?? {}) };
    if (p.tokens?.accessToken) headers.authorization = `Bearer ${p.tokens.accessToken}`;
    return apiRequestRaw(method, path, { ...(opts.body !== undefined ? { body: opts.body } : {}), ...(opts.form ? { form: opts.form } : {}), headers });
  };
  const go = () => (opts.rateLimitRetry === false ? send() : withRateLimitRetry(send));
  let r = await go();
  if (r.status === 401 && codeOf(r) !== "ASSERTION_INVALID") {
    if (!(await refresh(p))) await loginPersona(p);
    r = await go();
  }
  // No automatic consent (GDPR Art. 7, PIPL Art. 39; p2 B1): a 403 AI_CONSENT_REQUIRED / PIPL_CONSENT_REQUIRED is
  // returned as is; the persona decides (`as <p> privacy consent` / `privacy pipl-consent`).
  if (r.status === 429) fail("RATE_LIMITED", `${method} ${path} still rate limited after retries`, { httpStatus: 429, body: r.body });
  return r;
}

/** A valid (refreshed if needed) access token for control-port calls that act as the persona. */
export async function freshAccessToken(p: PersonaFile): Promise<string> {
  const r = await personaRequest(p, "GET", "/me");
  if (r.status >= 400) ensureOk(r, "GET /me");
  return p.tokens!.accessToken;
}
