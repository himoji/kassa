import type { FastifyInstance, FastifyReply } from "fastify";
import { formatMoney } from "@kassa/shared";
import { z } from "zod";

import type { MockBank } from "../bank/bank.ts";
import type { RateProvider } from "../bank/rates.ts";
import type { Clock } from "../clock.ts";
import type { MockWorldConfig } from "../config.ts";
import { HttpError, parseWith } from "../errors.ts";
import type { QrWallet } from "../qr/qr.ts";
import { QrError } from "../qr/qr.ts";
import { type ApiResult, problemCode, type StageApi, StageApiError } from "../stage/client.ts";
import { STAGE_CSS, STAGE_JS } from "../stage/assets.ts";
import { renderBank, renderDirector, renderHome, renderMail, renderSupplier, renderTap, renderWallet } from "../stage/pages.ts";
import { A1_HIDDEN_INSTRUCTION, inboxEmails, SUPPLIERS } from "../world/data.ts";
import type { DocumentCache } from "./documents.ts";
import { pizzaCheckout, type ShopDeps } from "./shop.ts";

/*
 * Demo Stage (/mock/stage/*): phone-sized "outside world" screens for the live pitch. Pages are plain HTML; every
 * button posts to /mock/stage/api/<action>, and only this server talks to the Kassa API (StageApi holds the demo
 * admin token and the Shortcut device token; neither is ever rendered). The whole tree is 404 unless DEMO_ENABLED.
 *
 * Actions answer 200 with {ok, tone, title, detail, data} whenever the action ran, including when Kassa refused:
 * a refusal is the demo's point. Bad input → 400; the API unreachable or misconfigured → 502.
 */

export interface StageDeps {
  config: MockWorldConfig;
  api: StageApi;
  bank: MockBank;
  qr: QrWallet;
  docs: DocumentCache;
  shop: ShopDeps;
  clock: Clock;
  rates: RateProvider;
  /** Resets the mock world's own in-memory state (bank, QR wallet, charges). */
  resetWorld: () => void;
  /** Drops the cached demo-clock offset so the next read follows a clock move this server just made. */
  syncClock: () => void;
}

type Tone = "ok" | "bad" | "warn" | "info";
interface ActionResult {
  ok: boolean;
  tone: Tone;
  title: string;
  detail: string;
  data?: unknown;
}

/** Scene 1 constants (generic names, spec §0). */
export const STAGE_TAP = {
  coffee: { merchant: "Coffee Shop in Budapest", amountMinor: 420, currency: "EUR", card: "Debit card 4821" },
  dcc: { merchant: "Gift Shop in Budapest", localAmountMinor: 1_299_000, localCurrency: "HUF", chargedCurrency: "KZT", markupBps: 600, card: "Debit card 4821" },
} as const;

/** Mail messages that can be forwarded (tuition invoice, A2 lookalike). */
const FORWARDABLE = { "msg-0001": "invoice", "msg-0005": "email_change_request" } as const;

const ActionParam = z.object({
  action: z.enum([
    "tap-coffee",
    "tap-dcc",
    "tap-dcc-settle",
    "tap-card",
    "wallet-swap",
    "wallet-pay",
    "wallet-notify",
    "mail-forward",
    "clock",
    "bank-forged",
    "home-send",
    "reset",
  ]),
});

function apiDetail(r: ApiResult): string {
  const b = r.body as { title?: unknown; detail?: unknown; error?: unknown; message?: unknown } | null;
  const code = problemCode(r.body);
  const msg = [b?.detail, b?.message, b?.error, b?.title].find((x) => typeof x === "string") as string | undefined;
  return `HTTP ${r.status}${code ? ` ${code}` : ""}${msg ? `: ${msg}` : ""}`;
}

/** The API refused for configuration reasons (no token / wrong token / demo off / not seeded): not a demo outcome. */
function configProblem(r: ApiResult): ActionResult | null {
  if (r.status === 403 || r.status === 404 || r.status === 409 || r.status >= 500) {
    const code = problemCode(r.body);
    if (r.status === 403 || code === "NOT_FOUND" || code === "DEMO_NOT_SEEDED" || r.status >= 500) {
      return {
        ok: false,
        tone: "bad",
        title: r.status >= 500 ? "Kassa API error" : "Kassa API refused the stage call",
        detail: r.status >= 500 ? apiDetail(r) : `${apiDetail(r)}. Check DEMO_ENABLED and DEMO_ADMIN_TOKEN on both services, and that the demo is seeded.`,
      };
    }
  }
  return null;
}

function samePath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

export function stageRoutes(app: FastifyInstance, deps: StageDeps): void {
  /** Last DCC tap waiting for its statement line. */
  let pendingDcc: { transactionId: string; chargedMinor: number; localMinor: number } | null = null;

  const html = (reply: FastifyReply, body: string) => reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(body);

  app.addHook("onRequest", async (req, reply) => {
    if (!deps.config.demoEnabled && req.url.startsWith("/mock/stage")) {
      return reply.code(404).send({ error: "Not found", code: "NOT_FOUND" });
    }
  });

  app.get("/stage", async (_req, reply) => html(reply, renderDirector()));
  app.get("/stage/tap", async (_req, reply) => html(reply, renderTap()));
  app.get("/stage/wallet", async (_req, reply) => html(reply, renderWallet()));
  app.get("/stage/mail", async (_req, reply) =>
    html(
      reply,
      renderMail(
        inboxEmails(deps.config.publicUrl)
          .filter((e) => e.id in FORWARDABLE || e.tag === "normal")
          // Same-origin paths: on the phone the page is reached through a proxy / tunnel, not MOCK_PUBLIC_URL.
          .map(({ tag: _tag, ...e }) => ({ ...e, attachments: e.attachments.map((a) => ({ name: a.name, url: samePath(a.url) })) })),
      ),
    ),
  );
  app.get("/stage/bank", async (_req, reply) => html(reply, renderBank()));
  app.get("/stage/home", async (_req, reply) => html(reply, renderHome()));
  app.get("/stage/supplier", async (_req, reply) => {
    const b = SUPPLIERS.b;
    const visibleNotes = (b.notes ?? "").replace(A1_HIDDEN_INSTRUCTION, "").trim();
    return html(
      reply,
      renderSupplier({
        name: b.name,
        city: b.city,
        items: b.items.map((i) => ({ sku: i.sku, name: i.name, unit: i.unit, price: formatMoney(i.priceMinor, b.currency), minOrder: i.minOrder })),
        visibleNotes,
        hiddenText: A1_HIDDEN_INSTRUCTION,
        priceListUrl: "/mock/suppliers/b/price-list.pdf",
      }),
    );
  });

  app.get("/stage/stage.css", async (_req, reply) => reply.type("text/css; charset=utf-8").header("cache-control", "no-cache").send(STAGE_CSS));
  app.get("/stage/stage.js", async (_req, reply) => reply.type("text/javascript; charset=utf-8").header("cache-control", "no-cache").send(STAGE_JS));

  // Read-only state the screens poll. Nothing secret: QR codes, mock-bank transfers, the last card the terminal saw.
  app.get("/stage/api/state", async () => {
    await deps.bank.tick();
    const latest = deps.qr.list()[0] ?? null;
    const lastApproved = [...deps.shop.log.charges].reverse().find((c) => c.result.approved) ?? null;
    return {
      simulated: true,
      demoTokenConfigured: deps.api.hasDemoToken,
      tap: {
        lastCardId: lastApproved?.cardId ?? null,
        pendingDcc: pendingDcc ? { charged: formatMoney(pendingDcc.chargedMinor, STAGE_TAP.dcc.chargedCurrency), local: formatMoney(pendingDcc.localMinor, STAGE_TAP.dcc.localCurrency) } : null,
      },
      wallet: {
        swapAll: deps.qr.swapAll,
        latest: latest
          ? {
              paymentId: latest.paymentId,
              payeeName: latest.payeeName,
              intendedPayeeName: latest.intendedPayeeName,
              swapped: latest.payeeName !== latest.intendedPayeeName,
              amount: formatMoney(latest.amountMinor, latest.currency),
              amountMinor: latest.amountMinor,
              currency: latest.currency,
              reference: latest.reference,
              status: latest.status,
              qrPayload: latest.qrPayload,
              createdAt: latest.createdAt,
            }
          : null,
      },
      bank: {
        transfers: deps.bank
          .listTransfers()
          .slice()
          .sort((a, b) => b.id - a.id)
          .slice(0, 5)
          .map((t) => ({
            id: t.id,
            status: t.status,
            reference: t.reference,
            source: formatMoney(t.sourceAmountMinor, t.sourceCurrency),
            target: formatMoney(t.targetAmountMinor, t.targetCurrency),
            created: t.created,
            history: t.history,
          })),
      },
    };
  });

  app.post("/stage/api/:action", async (req, reply) => {
    const { action } = parseWith(ActionParam, req.params, "params");
    try {
      const result = await runAction(action, req.body ?? {});
      return reply.send(result);
    } catch (err) {
      if (err instanceof StageApiError) {
        return reply.code(502).send({ ok: false, tone: "bad", title: "Kassa API call failed", detail: err.message } satisfies ActionResult);
      }
      throw err;
    }
  });

  async function trigger(scenario: string): Promise<ApiResult> {
    return deps.api.demo(`trigger/${scenario}`);
  }

  async function runAction(action: z.infer<typeof ActionParam>["action"], body: unknown): Promise<ActionResult> {
    switch (action) {
      // ---------- Scene 1: Tap to Pay (simulated) ----------
      case "tap-coffee": {
        const c = STAGE_TAP.coffee;
        const r = await deps.api.shortcutCapture({
          merchant: c.merchant,
          amount: formatMoney(c.amountMinor, c.currency),
          currency: c.currency,
          card: c.card,
          date: (await deps.clock.now()).toISOString(),
        });
        if (r.status !== 200) return configProblem(r) ?? { ok: false, tone: "bad", title: "Capture failed", detail: apiDetail(r) };
        const b = r.body as { status?: string; notification?: { en?: { body?: string } } | null };
        return {
          ok: true,
          tone: b.status === "LOGGED" ? "ok" : "info",
          title: b.status === "MERGED" ? "Kassa merged a duplicate sighting" : "Kassa logged the purchase",
          detail: b.notification?.en?.body ?? `Status ${b.status ?? "?"}. Capture only logs: no proposal, no payment (I6).`,
          data: r.body,
        };
      }
      case "tap-dcc": {
        const d = STAGE_TAP.dcc;
        const table = await deps.rates.getRates();
        const from = Number(table.rates[d.localCurrency]);
        const to = Number(table.rates[d.chargedCurrency]);
        if (!(from > 0 && to > 0)) return { ok: false, tone: "bad", title: "No example rate", detail: `No ${d.localCurrency}/${d.chargedCurrency} rate` };
        // Display-side estimate only (the API recomputes the mid on the purchase date): local price x mid x (1 + markup).
        const chargedMinor = Math.round(((d.localAmountMinor * to) / from) * (1 + d.markupBps / 10_000));
        const r = await deps.api.shortcutCapture({
          merchant: d.merchant,
          amount: formatMoney(chargedMinor, d.chargedCurrency),
          currency: d.chargedCurrency,
          card: d.card,
          date: (await deps.clock.now()).toISOString(),
        });
        if (r.status !== 200) return configProblem(r) ?? { ok: false, tone: "bad", title: "Capture failed", detail: apiDetail(r) };
        const tx = (r.body as { transactionId?: string | null }).transactionId;
        if (!tx) return { ok: false, tone: "warn", title: "Not logged", detail: `Capture status ${(r.body as { status?: string }).status ?? "?"}` };
        pendingDcc = { transactionId: tx, chargedMinor, localMinor: d.localAmountMinor };
        return {
          ok: true,
          tone: "warn",
          title: `Charged ${formatMoney(chargedMinor, d.chargedCurrency)} instead of ${formatMoney(d.localAmountMinor, d.localCurrency)}`,
          detail: "The terminal converted to your home currency itself (dynamic currency conversion). Kassa logged it; the statement will show the cost.",
          data: r.body,
        };
      }
      case "tap-dcc-settle": {
        if (!pendingDcc) return { ok: false, tone: "warn", title: "Nothing to settle", detail: "Tap at the gift shop terminal first." };
        const d = STAGE_TAP.dcc;
        const r = await deps.api.demo("stage/settlement", {
          transactionId: pendingDcc.transactionId,
          amountMinor: pendingDcc.chargedMinor,
          currency: d.chargedCurrency,
          settledAmountMinor: pendingDcc.chargedMinor,
          settledCurrency: d.chargedCurrency,
          localAmountMinor: pendingDcc.localMinor,
          localCurrency: d.localCurrency,
        });
        if (r.status !== 200) {
          if (problemCode(r.body) === "SETTLEMENT_ALREADY_SETTLED") pendingDcc = null;
          return configProblem(r) ?? { ok: false, tone: "bad", title: "Settlement not applied", detail: apiDetail(r) };
        }
        pendingDcc = null;
        const dcc = (r.body as { dcc?: { overMidBps: number } | null }).dcc;
        return dcc
          ? { ok: true, tone: "bad", title: `Kassa flagged DCC: ${(dcc.overMidBps / 100).toFixed(2)}% over mid`, detail: "Fee x-ray warns you: next time pay in the local currency (HUF).", data: r.body }
          : { ok: true, tone: "info", title: "Settled, no DCC flag", detail: "The charge stayed within 2% of the mid rate.", data: r.body };
      }
      case "tap-card": {
        const { cardId } = parseWith(z.object({ cardId: z.string().trim().min(3).max(128) }), body);
        const r = await pizzaCheckout(deps.shop, { cardId, items: [{ sku: "PZ-MARG", quantity: 2 }] });
        const approved = r.body.status === "approved";
        return {
          ok: true,
          tone: approved ? "ok" : "bad",
          title: approved ? `Approved ${formatMoney(r.body.amountMinor, r.body.currency)}` : `Declined${r.body.reasonCode ? ` (${r.body.reasonCode})` : ""}`,
          detail: approved
            ? "The one-time card was charged once, for the exact signed order."
            : r.body.reasonCode === "CARD_ALREADY_USED"
              ? "Kassa's issuer declined the second charge: the one-time card is already spent."
              : "The issuer declined the charge.",
          data: r.body,
        };
      }

      // ---------- Scene 2: Super-App Wallet (simulated) ----------
      case "wallet-swap": {
        const { enabled } = parseWith(z.object({ enabled: z.boolean() }), body);
        deps.qr.swapAll = enabled;
        return {
          ok: true,
          tone: enabled ? "warn" : "info",
          title: enabled ? "Attack on: new QR codes name another payee" : "Attack off: QR codes are honest again",
          detail: enabled ? "Now ask Kassa to pay the shop: it compares the QR payee with the verified payee before you sign." : "",
          data: { swapAll: enabled },
        };
      }
      case "wallet-pay": {
        const { paymentId } = parseWith(z.object({ paymentId: z.string().uuid() }), body);
        const p = deps.qr.get(paymentId);
        if (!p) throw new HttpError(404, "NOT_FOUND", "Unknown payment code");
        if (p.payeeName !== p.intendedPayeeName) {
          // Kassa never hands a mismatched code to the wallet (QR_PAYEE_MISMATCH before signing). The stage will not either.
          return { ok: false, tone: "bad", title: `This code pays ${p.payeeName}`, detail: `Not ${p.intendedPayeeName}. Kassa refused before signing (A5, QR_PAYEE_MISMATCH).` };
        }
        try {
          const paid = await deps.qr.pay(paymentId);
          return { ok: true, tone: "ok", title: `Paid ${formatMoney(paid.amountMinor, paid.currency)} to ${paid.payeeName}`, detail: "The wallet sent a signed notice to Kassa; the payment turns SENT.", data: { status: paid.status } };
        } catch (err) {
          if (err instanceof QrError) return { ok: false, tone: "warn", title: err.code === "ALREADY_PAID" ? "Already paid" : "Payment failed", detail: err.message };
          throw err;
        }
      }
      case "wallet-notify": {
        const r = await trigger("cn-spending-day");
        if (r.status !== 200) return configProblem(r) ?? { ok: false, tone: "bad", title: "Trigger failed", detail: apiDetail(r) };
        const captured = ((r.body as { result?: { captured?: Array<{ status?: string; amountMinor?: number; currency?: string; homeAmountMinor?: number }> } }).result?.captured ?? []);
        const lines = captured.map((c) =>
          c.amountMinor && c.currency ? `${formatMoney(c.amountMinor, c.currency)}${c.homeAmountMinor ? ` = ${formatMoney(c.homeAmountMinor, "KZT")}` : ""} (${c.status ?? "?"})` : (c.status ?? "?"),
        );
        return { ok: true, tone: "ok", title: `Kassa logged ${captured.length} purchases in CNY`, detail: lines.join("; "), data: r.body };
      }

      // ---------- Scene 3: Mail (simulated) ----------
      case "mail-forward": {
        const { id } = parseWith(z.object({ id: z.enum(["msg-0001", "msg-0005"]) }), body);
        const kind = FORWARDABLE[id];
        let doc: { filename: string; mediaType: "application/pdf" | "text/plain"; data: Uint8Array };
        if (id === "msg-0001") {
          const bytes = deps.docs.invoices.university;
          if (!bytes) throw new HttpError(500, "INTERNAL", "tuition invoice not rendered");
          doc = { filename: "tuition-invoice.pdf", mediaType: "application/pdf", data: bytes };
        } else {
          const e = inboxEmails(deps.config.publicUrl).find((m) => m.id === id)!;
          const text = `From: ${e.from}\nTo: ${e.to}\nDate: ${e.date}\nSubject: ${e.subject}\n\n${e.body}\n`;
          doc = { filename: "forwarded-email.txt", mediaType: "text/plain", data: new TextEncoder().encode(text) };
        }
        const r = await deps.api.demo("stage/document", { filename: doc.filename, mediaType: doc.mediaType, kind, dataB64: Buffer.from(doc.data).toString("base64") });
        if (r.status !== 200) return configProblem(r) ?? { ok: false, tone: "bad", title: "Forward failed", detail: apiDetail(r) };
        if (id === "msg-0005") {
          // Same notification the app's demo menu sends for A2.
          const t = await trigger("landlord-iban-email");
          if (t.status !== 200) return configProblem(t) ?? { ok: false, tone: "bad", title: "Trigger failed", detail: apiDetail(t) };
        }
        return {
          ok: true,
          tone: id === "msg-0001" ? "ok" : "warn",
          title: "Forwarded to Kassa",
          detail:
            id === "msg-0001"
              ? "Kassa's Reader will extract payee, IBAN, amount and reference, each tied to evidence in the PDF."
              : "Kassa reads it as data. A new account can only become a new payee in 24 h cooling; rent keeps going to the verified account.",
          data: r.body,
        };
      }

      // ---------- Scene 4: Bank App (simulated) ----------
      case "bank-forged": {
        const latest = deps.bank.listTransfers().slice().sort((a, b) => b.id - a.id)[0];
        const now = await deps.clock.now();
        const at = now.toISOString();
        const forged = {
          data: {
            resource: { type: "transfer", id: latest?.id ?? 99_999_999, profile_id: latest?.profile ?? 16_000_001, account_id: latest?.targetAccount ?? 1 },
            current_state: "outgoing_payment_sent",
            previous_state: latest?.status ?? "processing",
            occurred_at: at,
          },
          subscription_id: "fake-bank",
          event_type: "transfers#state-change",
          schema_version: "2.0.0",
          sent_at: at,
        };
        const { unsigned, wrongKey } = await deps.api.forgedBankWebhook(forged, Math.floor(now.getTime() / 1000));
        const rejected = unsigned.status === 401 && wrongKey.status === 401;
        return {
          ok: true,
          tone: rejected ? "ok" : "bad",
          title: rejected ? "Kassa rejected a forged bank message" : "Unexpected answer to a forged message",
          detail: `Unsigned: ${apiDetail(unsigned)}. Wrong key: ${apiDetail(wrongKey)}. Payment status unchanged (I13).`,
          data: { unsigned: unsigned.status, wrongKey: wrongKey.status },
        };
      }
      case "clock": {
        const { hours } = parseWith(z.object({ hours: z.union([z.literal(1), z.literal(24), z.literal(72)]) }), body);
        const r = await deps.api.demo("clock/advance", { hours });
        if (r.status !== 200) return configProblem(r) ?? { ok: false, tone: "bad", title: "Clock not moved", detail: apiDetail(r) };
        // Without this the bank would tick (and sign webhooks) at the cached, pre-jump time for up to a second.
        deps.syncClock();
        await deps.bank.tick();
        return { ok: true, tone: "info", title: `Demo clock +${hours} h`, detail: `Now ${(r.body as { now?: string }).now ?? "?"}. Scheduler ran once.`, data: r.body };
      }

      // ---------- Scene 5: Money from home ----------
      case "home-send": {
        const r = await trigger("money-from-home");
        if (r.status !== 200) return configProblem(r) ?? { ok: false, tone: "bad", title: "Transfer failed", detail: apiDetail(r) };
        return { ok: true, tone: "ok", title: `Sent ${formatMoney(100_000_000, "KZT")} to Dana`, detail: "Kassa gets a signed notice and updates routes and coverage. Nothing is paid until Dana approves.", data: r.body };
      }

      // ---------- Director ----------
      case "reset": {
        const r = await deps.api.demo("reset");
        // The API's reset also calls POST /mock/reset; do it here too in case the API cannot reach us.
        deps.resetWorld();
        deps.api.reset();
        deps.syncClock();
        pendingDcc = null;
        if (r.status !== 200) return configProblem(r) ?? { ok: false, tone: "bad", title: "Reset failed", detail: apiDetail(r) };
        return { ok: true, tone: "ok", title: "Demo reset", detail: `Seed restored, clock ${(r.body as { now?: string }).now ?? "?"}.`, data: r.body };
      }
    }
  }
}
