/*
 * (M6) `sim story`: the whole connected world in one command, against a freshly started sim (api + mock-world,
 * DEMO_ENABLED, ISSUING_PROVIDER=fake, agent REPLAY). Every beat goes over the same HTTP surfaces the apps and the
 * mock third parties use; personas sign with their soft passkeys. Nothing is shortcut through the database.
 *
 *  1. setup     Dana (the seeded hero), the Budapest and Shanghai owners: registered, onboarded, shops visible.
 *  2. pizza     "Order me 2 pizzas" (REPLAY pizza-order.json) → approve → the shop charges the one-time card →
 *               kitchen advances → DELIVERED.
 *  3. till      a counter-till bill at bud → Dana proposes it by id → approve → till PAID.
 *  4. restock   Shanghai forecast (boxes short) → the agent drafts a PO (REPLAY business-restock.json) → the owner
 *               signs it with the payments passkey → supplier C confirms.
 *  5. attack    supplier D invoices C's PO with its own account → refused INVOICE_ACCOUNT_MISMATCH.
 *  6. invoice   supplier C delivers and invoices → three-way match → QR handoff payment approved and paid → PO PAID.
 *  7. shortcut  an Apple Pay Shortcut capture returns a nudge.
 *  8. ledger    ledger.verify() ok.
 *
 * Prints one evidence object; `ok` is false (exit 1 in the CLI) if any beat failed. The servers it started are
 * always stopped (finally + SIGINT/SIGTERM), even when a beat throws.
 */
import { randomUUID } from "node:crypto";

import { approve, demo, mockGet, mockPost, onboard, orderView, payQr, result, settleWebhooks } from "./commands.ts";
import { API_BASE } from "./config.ts";
import { codeOf, control } from "./http.ts";
import { down, up } from "./lifecycle.ts";
import { fail, SimError } from "./out.ts";
import { assertWith, authenticatorOf, type PersonaFile, personaRequest, registerPersona, savePersona } from "./persona.ts";

type Beat = { ok: boolean; ms: number; error?: { code: string; message: string; extra?: unknown }; [k: string]: unknown };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(cond: unknown, code: string, message: string, extra: Record<string, unknown> = {}): asserts cond {
  if (!cond) fail(code, message, extra);
}

async function get<T>(p: PersonaFile, path: string): Promise<T> {
  return result(await personaRequest(p, "GET", path), `GET ${path}`).data as T;
}

async function post<T>(p: PersonaFile, path: string, body: unknown = {}): Promise<T> {
  return result(await personaRequest(p, "POST", path, { body }), `POST ${path}`).data as T;
}

/** Poll `fn` until it returns a truthy value (webhooks are delivered asynchronously by mock-world's outbox). */
async function until<T>(fn: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    last = v;
    await sleep(250);
  }
  return fail("STORY_TIMEOUT", `timed out waiting for ${what}`, { last });
}

/** One chat turn as the app sends it (AI SDK UI message stream; the stream ends when the turn is done). */
async function chat(p: PersonaFile, conversationId: string, text: string): Promise<string> {
  const send = () => personaRequest(p, "POST", "/agent/message", { body: { conversationId, text } });
  let r = await send();
  if (r.status === 403 && codeOf(r) === "PIPL_CONSENT_REQUIRED") {
    // Region CN: the owner gives the separate cross-border AI consent deliberately (PIPL Art. 38–39), then retries.
    result(await personaRequest(p, "POST", "/privacy/pipl-consent", { body: { consent: true } }), "POST /privacy/pipl-consent");
    r = await send();
  }
  result(r, `POST /agent/message "${text}"`);
  return (r.body as { raw?: string } | null)?.raw ?? JSON.stringify(r.body);
}

async function approveIfPending(p: PersonaFile, proposalId: string) {
  const v = (await orderView(p, proposalId)).data as unknown as { status: string; decision: string; hashMatches: boolean };
  if (v.status !== "PENDING_APPROVAL") return { approved: false, status: v.status, decision: v.decision };
  const a = (await approve(p, proposalId)) as { data: { paymentId: string | null; paymentStatus: string | null; tier: string }; signedOrderHash: string };
  return { approved: true, decision: v.decision, hashMatches: v.hashMatches, tier: a.data.tier, paymentId: a.data.paymentId, paymentStatus: a.data.paymentStatus, signedOrderHash: a.signedOrderHash };
}

type Proposal = { proposalId: string; status: string; decision: string; payeeName: string; amountMinor: number; currency: string; reasonCodes: string[] };
type ShopOrder = { id: string; externalOrderId: string | null; billId: string | null; status: string; final: boolean; timeline?: { status: string }[]; totalMinor: number; currency: string; merchantName: string };
type Po = { id: string; status: string; createdBy: string; supplierName: string; totalMinor: number; currency: string; reasonCodes: string[]; proposalId?: string | null; poHash?: string | null; lines: unknown[] };

type Ctx = { dana?: PersonaFile; bud?: PersonaFile; sha?: PersonaFile; poId?: string };

async function setup(ctx: Ctx) {
  const reg = async (name: string, claim: true | string, noMandate: boolean) => {
    const { persona, session } = await registerPersona(name, { claimDemo: claim, force: true, aiConsent: true });
    if (!session.onboarded) await onboard(persona, { noMandate });
    return persona;
  };
  ctx.dana = await reg("dana", true, false);
  ctx.bud = await reg("owner-bud", "pizzeria-bud", true);
  ctx.sha = await reg("owner-sha", "pizzeria-sha", true);
  const shops: Record<string, unknown> = {};
  for (const [k, p] of [["bud", ctx.bud], ["sha", ctx.sha]] as const) {
    const me = await get<{ accountType?: string }>(p, "/me");
    check(me.accountType === "BUSINESS", "NOT_BUSINESS", `${p.name} is not a business account`, { me });
    const inv = await get<{ merchant: { slug?: string; name: string; currency: string }; items: unknown[] }>(p, "/business/inventory");
    check(inv.items.length > 0, "NO_INVENTORY", `${k} has no inventory`);
    shops[k] = { merchant: inv.merchant, inventoryItems: inv.items.length };
  }
  return { personas: { dana: ctx.dana.userId, ownerBud: ctx.bud.userId, ownerSha: ctx.sha.userId }, shops };
}

async function pizza(ctx: Ctx) {
  const dana = ctx.dana!;
  await chat(dana, randomUUID(), "Order me 2 pizzas");
  const { proposals } = await get<{ proposals: Proposal[] }>(dana, "/proposals?limit=5");
  const prop = proposals[0];
  check(prop, "NO_PROPOSAL", "the pizza turn proposed nothing");
  check(prop.decision !== "REFUSE", "REFUSED", "rules refused the pizza order", { proposal: prop });
  const approval = await approveIfPending(dana, prop.proposalId);
  const order = await until(async () => (await get<{ shopOrders: ShopOrder[] }>(dana, `/shop-orders?proposalId=${prop.proposalId}`)).shopOrders[0], "the shop order");
  check(order.externalOrderId, "NO_EXTERNAL_ORDER", "shop order has no external id", { order });
  // The kitchen screen's buttons: RECEIVED → ACCEPTED → COOKING → OUT_FOR_DELIVERY → DELIVERED.
  for (let i = 0; i < 4; i++) {
    const r = await mockPost(`/shop/bud/orders/${encodeURIComponent(order.externalOrderId)}/advance`, {});
    check(r.ok, "KITCHEN_ADVANCE_FAILED", `kitchen advance ${i + 1} failed`, { mock: r });
  }
  await settleWebhooks();
  const done = await until(async () => {
    const o = (await get<ShopOrder>(dana, `/shop-orders/${order.id}`));
    return o.status === "DELIVERED" ? o : null;
  }, "the order to be DELIVERED");
  const charges = (await mockGet("/shop/bud/charges")).data as { charges: { result: { approved: boolean } }[] };
  return {
    proposal: { id: prop.proposalId, decision: prop.decision, payeeName: prop.payeeName, amountMinor: prop.amountMinor, currency: prop.currency },
    approval,
    shopOrder: { id: done.id, externalOrderId: done.externalOrderId, status: done.status, timeline: done.timeline?.map((t) => t.status) },
    shopCharges: charges.charges.length,
  };
}

async function till(ctx: Ctx) {
  const dana = ctx.dana!;
  const created = await mockPost("/shop/bud/bills", { items: [{ sku: "PZ-PEPP", qty: 1 }, { sku: "DR-COLA", qty: 2 }] });
  check(created.ok, "BILL_CREATE_FAILED", "till could not create a bill", { mock: created });
  const bill = (created.data as { bill: { billId: string; totalMinor: number; payUrl: string } }).bill;
  // The customer scanned /pay/<billId>: only the id goes to Kassa; amount and merchant come from the till.
  const prop = await post<{ proposalId: string; decision: string; reasonCodes: string[] }>(dana, `/merchant-bills/${bill.billId}/propose`);
  check(prop.decision !== "REFUSE", "REFUSED", "rules refused the till bill", { proposal: prop });
  const approval = await approveIfPending(dana, prop.proposalId);
  await settleWebhooks();
  const paid = await until(async () => {
    const b = (await mockGet(`/shop/bud/bills/${bill.billId}`)).data as { bill: { status: string } };
    return b.bill.status === "PAID" ? b.bill : null;
  }, "the till bill to be PAID");
  return { billId: bill.billId, totalMinor: bill.totalMinor, payUrl: bill.payUrl, proposal: prop, approval, tillStatus: paid.status };
}

async function poOf(p: PersonaFile, id: string): Promise<Po> {
  return get<Po>(p, `/business/purchase-orders/${id}`);
}

async function supplier(id: string, poId: string, action: "confirm" | "deliver" | "invoice") {
  const r = await mockPost(`/supplier/${id}/purchase-orders/${poId}/${action}`, {});
  check(r.ok, "SUPPLIER_ACTION_FAILED", `supplier ${id} ${action} failed`, { mock: r });
  await settleWebhooks();
}

async function restock(ctx: Ctx) {
  const sha = ctx.sha!;
  const forecast = await get<{ today: string; tomorrow: string; shortages: { sku: string; shortageQty?: number; [k: string]: unknown }[] }>(sha, "/business/forecast");
  const boxes = forecast.shortages.find((l) => l.sku.startsWith("BOX"));
  check(boxes, "NO_BOX_SHORTAGE", "the Shanghai forecast shows no box shortage", { shortages: forecast.shortages });
  const conv = randomUUID();
  await chat(sha, conv, "Will we run out of anything tomorrow?");
  await chat(sha, conv, "Order boxes from the usual supplier");
  const list = await get<{ items: Po[] }>(sha, "/business/purchase-orders");
  const draft = list.items.find((po) => po.status === "DRAFT");
  check(draft, "NO_DRAFT_PO", "the agent drafted no purchase order", { purchaseOrders: list.items.map((x) => ({ id: x.id, status: x.status })) });
  // The AI drafted; nothing payable exists yet.
  const proposalsBefore = (await get<{ proposals: Proposal[] }>(sha, "/proposals")).proposals.length;

  // The owner signs the PO core with the payments passkey (challenge = poHash).
  const o = await post<{ core: unknown; poHash: string; webauthnOptions: { challenge: string; rpId?: string } }>(sha, `/business/purchase-orders/${draft.id}/sign/options`);
  check(o.webauthnOptions.challenge === o.poHash, "CHALLENGE_NOT_POHASH", "sign challenge is not poHash", { options: o });
  const auth = authenticatorOf(sha);
  const assertion = assertWith(auth, o.poHash, o.webauthnOptions.rpId ? { rpId: o.webauthnOptions.rpId } : {});
  sha.credential = auth.export();
  savePersona(sha);
  const signed = await post<{ status?: string }>(sha, `/business/purchase-orders/${draft.id}/sign`, { core: o.core, assertion });
  await settleWebhooks();
  const sent = await poOf(sha, draft.id);
  check(["SENT", "SIGNED"].includes(sent.status), "PO_NOT_SENT", `PO is ${sent.status} after signing`, { po: sent });
  await supplier("c", draft.id, "confirm");
  const confirmed = await until(async () => {
    const po = await poOf(sha, draft.id);
    return po.status === "CONFIRMED" ? po : null;
  }, "the PO to be CONFIRMED");
  ctx.poId = draft.id;
  return {
    forecast: { today: forecast.today, tomorrow: forecast.tomorrow, boxShortage: boxes },
    draft: { id: draft.id, createdBy: draft.createdBy, supplierName: draft.supplierName, totalMinor: draft.totalMinor, currency: draft.currency, reasonCodes: draft.reasonCodes },
    proposalsWhileDraft: proposalsBefore,
    signed: { poHash: o.poHash, result: signed },
    status: confirmed.status,
  };
}

async function attack(ctx: Ctx) {
  const sha = ctx.sha!;
  check(ctx.poId, "NO_PO", "no confirmed PO (restock beat failed)");
  const r = await mockPost("/supplier/d/attack/swapped-invoice", { purchaseOrderId: ctx.poId });
  check(r.ok, "ATTACK_SEND_FAILED", "supplier D's swapped invoice was not sent", { mock: r });
  await settleWebhooks();
  const po = await until(async () => {
    const x = await poOf(sha, ctx.poId!);
    return x.reasonCodes.includes("INVOICE_ACCOUNT_MISMATCH") ? x : null;
  }, "the swapped invoice to be refused");
  check(po.status === "CONFIRMED" && !po.proposalId, "ATTACK_NOT_CONTAINED", "the refused invoice changed the PO", { po });
  const proposals = (await get<{ proposals: Proposal[] }>(sha, "/proposals")).proposals.length;
  check(proposals === 0, "ATTACK_PROPOSED", "a proposal exists after the refused invoice", { proposals });
  return { refused: true, reasonCodes: po.reasonCodes, poStatus: po.status, proposals };
}

async function invoice(ctx: Ctx) {
  const sha = ctx.sha!;
  check(ctx.poId, "NO_PO", "no confirmed PO (restock beat failed)");
  const poId = ctx.poId;
  await supplier("c", poId, "deliver");
  await supplier("c", poId, "invoice");
  const invoiced = await until(async () => {
    const x = await poOf(sha, poId);
    return x.status === "INVOICED" && x.proposalId ? x : null;
  }, "the PO to be INVOICED with a payment proposal");
  const approval = await approveIfPending(sha, invoiced.proposalId!);
  check(approval.approved && approval.paymentId, "NOT_APPROVED", "the invoice payment was not approved", { approval });
  const qr = await payQr(sha, approval.paymentId);
  check(qr.paid, "QR_NOT_PAID", "the QR handoff was not paid", { qr });
  await settleWebhooks();
  const paid = await until(async () => {
    const x = await poOf(sha, poId);
    return x.status === "PAID" ? x : null;
  }, "the PO to be PAID");
  return { proposalId: invoiced.proposalId, approval, qr: { qrPaymentId: qr.qrPaymentId, check: qr.handoff.check }, poStatus: paid.status, totalMinor: paid.totalMinor, currency: paid.currency };
}

async function shortcut(ctx: Ctx) {
  const dana = ctx.dana!;
  const dev = await post<{ deviceId: string; token: string }>(dana, "/devices/shortcut");
  // The iOS Shortcut posts with its own device token (no session), like the real Transaction automation.
  const res = await fetch(`${API_BASE}/api/capture/shortcut`, {
    method: "POST",
    headers: { authorization: `Bearer ${dev.token}`, "content-type": "application/json", "x-forwarded-for": dana.clientIp },
    body: JSON.stringify({ merchant: "Coffee House", amount: "1 200 Ft", card: "Visa", date: new Date().toISOString() }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => null)) as { nudge?: string } | null;
  check(res.status === 200 && typeof body?.nudge === "string" && body.nudge.length > 0, "NO_NUDGE", "Shortcut capture returned no nudge", { httpStatus: res.status, body });
  return { deviceId: dev.deviceId, httpStatus: res.status, nudge: body!.nudge };
}

async function ledgerBeat() {
  const r = await control<{ ok: boolean; [k: string]: unknown }>("/ledger-verify");
  check(r.ok, "LEDGER_INVALID", "ledger verification failed", { report: r });
  return r;
}

export async function story(): Promise<{ ok: boolean; [k: string]: unknown }> {
  const started = Date.now();
  // A development-mode stack with the fake card issuer and deterministic agent turns.
  process.env.ISSUING_PROVIDER = "fake";
  process.env.SHOP_AUTOPILOT = "false";
  const upResult = await up({ fresh: true, scheduler: false, liveFx: false });
  if (!(upResult as { started?: boolean }).started) fail("SIM_NOT_STARTED", "sim did not start fresh", { up: upResult });

  let stopping = false;
  const stop = async () => {
    if (stopping) return null;
    stopping = true;
    return down().catch((e: Error) => ({ error: e.message }));
  };
  const onSignal = (sig: NodeJS.Signals) => {
    void stop().finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const ctx: Ctx = {};
  const beats: Record<string, Beat> = {};
  const run = async (name: string, fn: () => Promise<Record<string, unknown>>) => {
    const t0 = Date.now();
    try {
      beats[name] = { ok: true, ms: Date.now() - t0, ...(await fn()) };
      beats[name]!.ms = Date.now() - t0;
    } catch (e) {
      const err = e instanceof SimError ? { code: e.code, message: e.message, extra: e.extra } : { code: "STORY_INTERNAL", message: (e as Error)?.message ?? String(e) };
      beats[name] = { ok: false, ms: Date.now() - t0, error: err };
    }
  };

  let stopped: unknown = null;
  try {
    await control("/health");
    const mode = await demoAgentMode();
    await run("setup", () => setup(ctx));
    if (beats.setup?.ok) {
      await run("pizza", () => pizza(ctx));
      await run("till", () => till(ctx));
      await run("restock", () => restock(ctx));
      await run("swappedInvoice", () => attack(ctx));
      await run("invoicePaid", () => invoice(ctx));
      await run("shortcut", () => shortcut(ctx));
    }
    await run("ledgerVerify", ledgerBeat);
    const ok = Object.values(beats).every((b) => b.ok) && Object.keys(beats).length === 8;
    stopped = await stop();
    return { ok, story: "kassa connected world (M6)", agentMode: mode, beats, failed: Object.keys(beats).filter((k) => !beats[k]!.ok), stopped, totalMs: Date.now() - started };
  } finally {
    if (!stopped) await stop();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function demoAgentMode(): Promise<string> {
  const r = (await demo("POST", "/demo/agent-mode", { mode: "REPLAY" })) as { data?: { mode?: string } };
  return r.data?.mode ?? "REPLAY";
}
