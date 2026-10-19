/*
 * Which Wise-shaped bank the bank rail talks to.
 *
 *   mock          (default) apps/mock-world: in-memory, offline, deterministic, status changes by webhook and poll.
 *   wise-sandbox  Wise's own sandbox (WISE_SANDBOX_TOKEN set): real quotes, fees, recipient-field validation and
 *                 transfer states, no real money. One sandbox profile (WISE_PROFILE_ID, else the first profile the
 *                 token sees) stands in for every Kassa user. The sandbox does not move transfers on its own, so
 *                 each status poll asks its simulation endpoints for the next state.
 *
 * Both speak the same routes (quotes v3, accounts v1, transfers v1, fund v3, balances v4). The differences are
 * amounts (Wise: decimal major units; mock: minor units too) and auth, handled here and in mockBank.ts.
 */
import { env } from "../../env.ts";
import { mockWorld } from "./http.ts";

export type BankMode = "mock" | "wise-sandbox";

export function bankMode(): BankMode {
  return env().WISE_SANDBOX_TOKEN ? "wise-sandbox" : "mock";
}

export class WiseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Wise's `errors[0].code` / `.path`, when it sent them (e.g. "NOT_VALID", "details.abartn"). */
    readonly code?: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

export type WiseTransport = (method: string, url: string, init: { headers: Record<string, string>; body?: string }) => Promise<{ status: number; json: unknown }>;

const defaultWiseTransport: WiseTransport = async (method, url, init) => {
  const res = await fetch(url, { method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}), signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
};

let wiseTransport: WiseTransport = defaultWiseTransport;

export function setWiseTransportForTests(t: WiseTransport | null): void {
  wiseTransport = t ?? defaultWiseTransport;
  wiseProfile = null;
}

async function wise<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const e = env();
  const url = `${e.WISE_API_URL.replace(/\/$/, "")}${path}`;
  const r = await wiseTransport(method, url, {
    headers: { authorization: `Bearer ${e.WISE_SANDBOX_TOKEN}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extraHeaders },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (r.status < 200 || r.status >= 300) {
    const first = (r.json as { errors?: { code?: string; message?: string; path?: string }[] } | null)?.errors?.[0];
    throw new WiseError(`Wise sandbox ${method} ${path} → ${r.status}${first?.message ? `: ${first.message}` : ""}`, r.status, first?.code, first?.path);
  }
  return r.json as T;
}

/**
 * One request to the active bank. `wiseHeaders` go to the Wise sandbox only (e.g. Wise's X-idempotence-uuid); the mock
 * bank takes its idempotency key in the body.
 */
export async function bankCall<T = Record<string, unknown>>(method: string, path: string, body?: unknown, wiseHeaders?: Record<string, string>): Promise<T> {
  return bankMode() === "wise-sandbox" ? wise<T>(method, path, body, wiseHeaders) : mockWorld<T>(method, path, body);
}

let wiseProfile: number | null = null;

/** The sandbox profile id: WISE_PROFILE_ID, else the first profile of the token (GET /v2/profiles), cached. */
export async function wiseSandboxProfile(): Promise<number> {
  const configured = env().WISE_PROFILE_ID;
  if (configured) return configured;
  if (wiseProfile !== null) return wiseProfile;
  const profiles = await wise<{ id: number; type?: string }[]>("GET", "/v2/profiles");
  const pick = profiles.find((p) => p.type?.toUpperCase() === "PERSONAL") ?? profiles[0];
  if (!pick) throw new WiseError("The Wise sandbox token has no profiles", 404);
  wiseProfile = pick.id;
  return pick.id;
}

/** Wise sandbox states in order; each poll moves a transfer one step (Wise's GET /v1/simulation/transfers/:id/:state). */
const SIMULATION_NEXT: Record<string, string> = {
  incoming_payment_waiting: "processing",
  processing: "funds_converted",
  funds_converted: "outgoing_payment_sent",
};

/** Sandbox only: ask Wise to move the transfer to its next state. Returns the new state, or null at the end. */
export async function simulateNextWiseState(transferId: string, current: string): Promise<string | null> {
  const next = SIMULATION_NEXT[current];
  if (!next) return null;
  const t = await wise<{ status?: string }>("GET", `/v1/simulation/transfers/${encodeURIComponent(transferId)}/${next}`);
  return t.status ?? next;
}
