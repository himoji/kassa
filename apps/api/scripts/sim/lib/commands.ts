/*
 * Persona user actions (HTTP against the real API, as the app would call it), planner tools (control port),
 * demo panel and mock-world commands. No company / payee names are hardcoded: everything is read from
 * API or mock-world responses.
 */
import { orderHash as computeOrderHash, formatMoney, fundingMarginNoteEn, reasonTextEn, type CanonicalOrder } from "@kassa/shared";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

import { pdfToText } from "../../../src/modules/reader/extract.ts";
import { ensureDir, FILES, MOCK_BASE, readText } from "./config.ts";
import { apiRequestRaw, codeOf, control, type HttpResult, mockRequest, problemOf, withRateLimitRetry } from "./http.ts";
import { fail } from "./out.ts";
import { assertWith, authenticatorOf, freshAccessToken, type PersonaFile, personaRequest, savePersona } from "./persona.ts";

/** 2xx → `{ok, httpStatus, data}`; otherwise a JSON error (exit 1) with the problem details. */
export function result(r: HttpResult, what: string): { ok: true; httpStatus: number; data: unknown } {
  if (r.status >= 400) {
    const p = problemOf(r);
    fail(codeOf(r) ?? `HTTP_${r.status}`, `${what}: ${p.detail ?? p.title ?? p.error ?? r.status}`, {
      httpStatus: r.status,
      reasonCodes: p.reasonCodes ?? [],
      ...(p.details !== undefined ? { details: p.details } : {}),
    });
  }
  return { ok: true, httpStatus: r.status, data: r.body };
}

type Challenge = { challengeId: string; webauthnOptions: { challenge: string; rpId?: string } };

function signWith(p: PersonaFile, challenge: string, rpId?: string) {
  const auth = authenticatorOf(p);
  const assertion = assertWith(auth, challenge, rpId ? { rpId } : {});
  p.credential = auth.export();
  savePersona(p);
  return assertion;
}

/** Passkey-gated write: the first call returns 428 + challenge; with `sign`, the persona signs and resends. */
export async function gated(p: PersonaFile, method: string, path: string, body: Record<string, unknown>, sign: boolean, what: string) {
  const first = await personaRequest(p, method, path, { body });
  if (first.status !== 428) return result(first, what);
  const details = problemOf(first).details as Challenge | undefined;
  if (!sign || !details?.challengeId || !details.webauthnOptions?.challenge) {
    return result(first, `${what} (passkey required: rerun with --sign to sign with this persona's passkey)`);
  }
  const assertion = signWith(p, details.webauthnOptions.challenge, details.webauthnOptions.rpId);
  const second = await personaRequest(p, method, path, { body: { ...body, challengeId: details.challengeId, assertion } });
  return { ...result(second, what), signed: true };
}

// ---------------------------------------------------------------- onboarding

/** Sign the base rules (and, unless `noMandate`, the suggested rent mandate) with the persona's passkey. */
export async function onboard(p: PersonaFile, opts: { noMandate: boolean }) {
  const conversationId = randomUUID();
  const o = result(await personaRequest(p, "POST", "/onboarding/confirm/options", { body: { conversationId } }), "onboarding/confirm/options").data as {
    core: unknown;
    rulesHash: string;
    challengeId: string;
    webauthnOptions: { rpId?: string };
    suggestedMandate: Record<string, unknown> | null;
    suggestedMandatePayees: { id: string; name: string }[];
  };
  const assertion = signWith(p, o.rulesHash, o.webauthnOptions.rpId);
  const c = await personaRequest(p, "POST", "/onboarding/confirm", { body: { conversationId, challengeId: o.challengeId, core: o.core, assertion } });
  const confirmed = c.status === 409 && codeOf(c) === "ALREADY_ONBOARDED" ? { alreadyOnboarded: true } : result(c, "onboarding/confirm").data;
  let mandate: unknown = null;
  if (o.suggestedMandate && !opts.noMandate) mandate = (await createMandate(p, o.suggestedMandate)).data;
  return { baseRules: confirmed, rulesHash: o.rulesHash, suggestedMandate: o.suggestedMandate, suggestedMandatePayees: o.suggestedMandatePayees, mandate };
}

/** Server builds the mandate core; the persona signs mandateHash; effective after 24 h (I8). */
export async function createMandate(p: PersonaFile, req: Record<string, unknown>) {
  const o = result(await personaRequest(p, "POST", "/mandates/options", { body: req }), "mandates/options").data as {
    core: unknown;
    mandateHash: string;
    webauthnOptions: { rpId?: string };
  };
  const assertion = signWith(p, o.mandateHash, o.webauthnOptions.rpId);
  return result(await personaRequest(p, "POST", "/mandates", { body: { core: o.core, assertion } }), "POST /mandates");
}

// ---------------------------------------------------------------- orders

/** GET /orders/:id plus a client-side recomputation of orderHash from the canonical order (I3). */
export async function orderView(p: PersonaFile, proposalId: string) {
  const r = result(await personaRequest(p, "GET", `/orders/${proposalId}`), "GET /orders/:id");
  const v = r.data as { canonicalOrder: CanonicalOrder; orderHash: string } & Record<string, unknown>;
  const recomputed = computeOrderHash(v.canonicalOrder);
  // What the user reads next to the codes (Y6): plain-language reasons and, for a converting order, why the
  // signed funding maximum is above the estimate.
  const codes = Array.isArray(v.reasonCodes) ? (v.reasonCodes as string[]) : [];
  const o = v.canonicalOrder;
  const fundingNote =
    o.fundingCurrency && o.fundingAmountMinor !== undefined && o.fundingCurrency !== o.currency
      ? fundingMarginNoteEn(formatMoney(o.fundingAmountMinor, o.fundingCurrency), o.fundingCurrency)
      : null;
  return {
    ...r,
    data: { ...v, recomputedOrderHash: recomputed, hashMatches: recomputed === v.orderHash, reasons: codes.map((c) => ({ code: c, text: reasonTextEn(c) })), fundingNote },
  };
}

/**
 * The user reviews the canonical order and signs it with their passkey (challenge = orderHash).
 * Never signs a re-issued order blindly (p2 B3, X8): if this read replaced an expired order
 * (`reissuedFromOrderHash`), or the server answers 410 ORDER_EXPIRED with the re-issued order, the new order is
 * shown and nothing is signed; the user reviews it and runs `approve` again (a second, explicit approval).
 */
export async function approve(p: PersonaFile, proposalId: string) {
  const view = (await orderView(p, proposalId)).data as unknown as {
    orderHash: string;
    hashMatches: boolean;
    webauthnOptions: { challenge: string; rpId?: string } | null;
    status: string;
    reissuedFromOrderHash?: string;
  };
  if (view.reissuedFromOrderHash) {
    fail("ORDER_REISSUED", "the order had expired and was re-issued; review the new order, then run approve again to sign it", {
      httpStatus: 200,
      expiredOrderHash: view.reissuedFromOrderHash,
      order: view,
    });
  }
  if (!view.webauthnOptions) fail("NOT_PENDING", `order is ${view.status}; nothing to sign`);
  if (!view.hashMatches) fail("ORDER_HASH_MISMATCH", "the canonical order does not hash to orderHash; refusing to sign");
  const assertion = signWith(p, view.webauthnOptions.challenge, view.webauthnOptions.rpId);
  p.lastAssertions[proposalId] = assertion;
  savePersona(p);
  const r = await personaRequest(p, "POST", `/orders/${proposalId}/approve`, { body: { assertion } });
  if (r.status === 410 && codeOf(r) === "ORDER_EXPIRED") {
    const reissued = problemOf(r).details as { canonicalOrder?: CanonicalOrder; orderHash?: string } | undefined;
    const recomputed = reissued?.canonicalOrder ? computeOrderHash(reissued.canonicalOrder) : null;
    fail("ORDER_EXPIRED", "the order expired before approval; the server re-issued it (nothing was signed for it). Review the new order, then run approve again", {
      httpStatus: 410,
      expiredOrderHash: view.orderHash,
      order: reissued ? { ...reissued, recomputedOrderHash: recomputed, hashMatches: recomputed === reissued.orderHash } : null,
    });
  }
  return { ...result(r, "approve"), signedOrderHash: view.orderHash };
}

// ---------------------------------------------------------------- documents, tools

export async function upload(p: PersonaFile, file: string, opts: { kind?: string; conversationId: string }) {
  const f = Bun.file(file);
  if (!(await f.exists())) fail("BAD_ARGS", `file not found: ${file}`);
  const ext = extname(file).toLowerCase();
  const type = f.type && f.type !== "application/octet-stream" ? f.type.split(";")[0]! : ext === ".pdf" ? "application/pdf" : ext === ".eml" ? "message/rfc822" : "text/plain";
  const form = new FormData();
  form.append("conversationId", opts.conversationId);
  if (opts.kind) form.append("kind", opts.kind);
  form.append("file", new Blob([await f.arrayBuffer()], { type }), basename(file));
  const r = result(await personaRequest(p, "POST", "/agent/documents", { form }), "upload");
  return { ...r, conversationId: opts.conversationId };
}

/**
 * One planner tool call through the daemon (real tools + redaction). Consent is never given automatically: without it
 * the daemon answers 403 AI_CONSENT_REQUIRED (or PIPL_CONSENT_REQUIRED for region CN) like the agent routes.
 */
export async function tool(p: PersonaFile, name: string, input: unknown, opts: { conversationId: string; readerOutput?: unknown }) {
  return control("/tool", { name, input, conversationId: opts.conversationId, ...(opts.readerOutput !== undefined ? { readerOutput: opts.readerOutput } : {}) }, await freshAccessToken(p));
}

/** The user's chat message → what the planner sees (redacted; payee names become payee_N refs). */
export async function say(p: PersonaFile, text: string, conversationId: string) {
  return control("/user-text", { text, conversationId }, await freshAccessToken(p));
}

// ---------------------------------------------------------------- handoff / QR

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Pay the QR request of a handoff payment in the mock QR wallet (only when the server shows a wallet link). */
export async function payQr(p: PersonaFile, paymentId: string) {
  const h = result(await personaRequest(p, "GET", `/handoff/${paymentId}`), "GET /handoff/:id").data as { check: string; walletUrl: string | null; qrPayload: string };
  if (h.check !== "MATCH" || !h.walletUrl) {
    return { ok: false, paid: false, reason: "The server shows no Pay button for this QR (payee check did not match)", handoff: h };
  }
  const qrId = UUID.exec(h.walletUrl)?.[0] ?? UUID.exec(h.qrPayload)?.[0];
  if (!qrId) fail("QR_ID_NOT_FOUND", "could not find the QR payment id in the handoff view", { handoff: h });
  const r = await mockRequest("POST", `/qr/${qrId}/pay`, {});
  return { ok: r.status < 400, paid: r.status < 400, qrPaymentId: qrId, mockStatus: r.status, mock: r.body, handoff: h };
}

// ---------------------------------------------------------------- demo panel

function demoHeaders(): Record<string, string> {
  const t = readText(FILES.demoToken);
  if (!t) fail("SIM_DOWN", "no demo token (sim not running?)");
  return { "x-kassa-demo-token": t };
}

export function parseHours(raw: string | undefined): number {
  const m = /^\+?(\d+)\s*([hd])?$/i.exec(raw ?? "");
  if (!m) fail("BAD_ARGS", "clock takes +Nh or +Nd (e.g. +1h, +1d, +3d)");
  const n = Number(m[1]) * (m[2]?.toLowerCase() === "d" ? 24 : 1);
  if (n <= 0 || n > 24 * 31) fail("BAD_ARGS", "advance between 1 hour and 31 days");
  return n;
}

export async function demo(method: string, path: string, body?: unknown) {
  return result(await withRateLimitRetry(() => apiRequestRaw(method, path, { headers: demoHeaders(), ...(body !== undefined ? { body } : {}) })), `${method} ${path}`);
}

// ---------------------------------------------------------------- mock world

export async function mockGet(path: string) {
  const r = await mockRequest("GET", path);
  if (r.status >= 400) fail("MOCK_ERROR", `GET /mock${path} → ${r.status}`, { httpStatus: r.status, body: r.body });
  return { ok: true, httpStatus: r.status, data: r.body };
}

export async function mockPost(path: string, body: unknown) {
  const r = await mockRequest("POST", path, body);
  return { ok: r.status < 400, httpStatus: r.status, data: r.body };
}

/** Download a mock invoice / price list PDF to .data/sim/files and return its text (what the Reader sees). */
export async function mockPdf(path: string, name: string) {
  const res = await fetch(`${MOCK_BASE}/mock${path}`, { signal: AbortSignal.timeout(15_000) }).catch((e: Error) =>
    fail("UNREACHABLE", e.message),
  );
  if (!res.ok) fail("MOCK_ERROR", `GET /mock${path} → ${res.status}`, { httpStatus: res.status });
  const bytes = new Uint8Array(await res.arrayBuffer());
  ensureDir(FILES.files);
  const file = resolve(FILES.files, name);
  writeFileSync(file, bytes);
  return { ok: true, file, bytes: bytes.length, text: await pdfToText(bytes) };
}

// ---------------------------------------------------------------- webhooks settle (Y7, p1 B11)

type OutboxEntry = { id: string; kind: string; status: string; createdAt: string; lastStatusCode: number | null; lastError: string | null };

/**
 * After the demo clock moved (or a tick / trigger ran): let the mock bank catch up with the new demo time
 * (POST /mock/bank/tick queues the transfer state-change webhooks), then wait until every webhook in the mock
 * outbox has been delivered or given up on. So `demo clock +1h` returns only once the API has seen the
 * resulting status changes (p1 B11). `apiNow` = the API's demo time after the change (waits for mock-world's
 * cached clock to reach it first). Reports what landed; `pending` > 0 only after the timeout.
 */
export async function settleWebhooks(
  apiNow: string | null = null,
  /** Real time (ms) when the command started: webhooks queued since then are reported (the mock ticker may win). */
  sinceMs: number = Date.now(),
  timeoutMs = 20_000,
): Promise<{ bankChanged: number; delivered: number; failed: number; pending: number; mockClockSynced: boolean; waitedMs: number }> {
  const started = Date.now();
  // mock-world caches the API's demo-clock offset for up to 1 s (mock-world/src/clock.ts refreshMs): a tick sent
  // before it caught up would run at the old time and change nothing. Wait until its clock reached the new time.
  let mockClockSynced = apiNow === null;
  const target = apiNow ? Date.parse(apiNow) - 60_000 : Number.NaN;
  while (!mockClockSynced && Date.now() - started < timeoutMs) {
    const h = (await mockRequest("GET", "/health")).body as { now?: unknown } | null;
    const now = typeof h?.now === "string" ? Date.parse(h.now) : Number.NaN;
    if (Number.isFinite(now) && now >= target) mockClockSynced = true;
    else await new Promise((r) => setTimeout(r, 200));
  }
  const tick = await mockRequest("POST", "/bank/tick", {});
  const bankChanged = Number((tick.body as { changed?: unknown } | null)?.changed ?? 0) || 0;
  let fresh: OutboxEntry[] = [];
  while (true) {
    const all = ((await mockRequest("GET", "/outbox")).body as { entries?: OutboxEntry[] } | null)?.entries ?? [];
    // Entries queued since this command started (by us or by mock-world's own ticker), plus any still in flight.
    fresh = all.filter((e) => Date.parse(e.createdAt) >= sinceMs - 1000 || e.status === "pending");
    if (!fresh.some((e) => e.status === "pending") || Date.now() - started > timeoutMs) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    bankChanged,
    delivered: fresh.filter((e) => e.status === "delivered").length,
    failed: fresh.filter((e) => e.status !== "delivered" && e.status !== "pending").length,
    pending: fresh.filter((e) => e.status === "pending").length,
    mockClockSynced,
    waitedMs: Date.now() - started,
  };
}
