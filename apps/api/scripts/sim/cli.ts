#!/usr/bin/env bun
/*
 * Kassa simulation CLI (`bun run sim <command>`). Every command prints ONE JSON object to stdout; errors
 * print {"error": CODE, ...} and exit 1. See docs/evidence/sim/RUNBOOK.md for usage and scenarios.
 *
 * Architecture: `sim up` starts a background daemon (scripts/sim/daemon.ts) that alone opens the sim
 * PGlite directory and hosts the real API (:4000), mock-world (:4001, child process) and a harness-only
 * control port (:4099, 127.0.0.1, token). User actions go over HTTP to the real API; planner tools go to
 * the control port, which runs the real agent tools + redaction in the DB-owning process.
 */
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";

import { type Args, flagBool, flagStr, parseArgs } from "./lib/args.ts";
import {
  approve,
  createMandate,
  demo,
  gated,
  mockGet,
  mockPdf,
  mockPost,
  onboard,
  orderView,
  parseHours,
  payQr,
  result,
  say,
  tool,
  upload,
} from "./lib/commands.ts";
import { FILES, removeFile } from "./lib/config.ts";
import { evidence, ledgerVerify, mark, report } from "./lib/evidence.ts";
import { control } from "./lib/http.ts";
import { down, logs, status, up } from "./lib/lifecycle.ts";
import { fail, jsonArg, print, printError, textArg } from "./lib/out.ts";
import { freshAccessToken, listPersonas, loadPersona, loginPersona, type PersonaFile, personaRequest, registerPersona } from "./lib/persona.ts";

const TOOL_NAMES = [
  "get_profile_summary",
  "get_balances",
  "get_budget",
  "get_obligations",
  "get_payee_facts",
  "search_catalog",
  "get_routes",
  "forecast_coverage",
  "read_document",
  "propose_order",
  "log_expense",
];

const USAGE = {
  lifecycle: ["up [--fresh] [--scheduler] [--live-fx]", "down", "status", "reset", "logs [--tail N]"],
  personas: ["register <persona> [--claim-demo [li-wei]] [--no-onboard] [--no-mandate] [--no-ai-consent] [--force]", "login <persona>", "onboard <persona> [--no-mandate]", "personas"],
  user: [
    "as <persona> me|balances|budgets [--category c]|obligations|forecast|cards|fees|transactions [--limit n --cursor c]|payees|mandates|caps|rule-changes|notifications|ledger [--limit n]|proposals [--status S]",
    "as <persona> add-payee '<json>' | verify-payee <payeeId> | create-mandate '<json>' | revoke-mandate <mandateId>",
    "as <persona> settings get | settings patch '<json>' [--sign]",
    "as <persona> freeze | unfreeze [--sign]",
    "as <persona> order <proposalId> | approve <proposalId> | reject <proposalId> [--reason text]",
    "as <persona> capture-event '<json>'|@file | settlement '<json>' | upload <file> [--kind invoice|notification|email_change_request] [--conversation id]",
    "as <persona> handoff <paymentId> | pay-qr <paymentId> | payment <paymentId>|--proposal <proposalId> | intent <paymentId> | simulate-intent <paymentId>",
    "as <persona> privacy notice|export [--out file]|consent [--withdraw]|restrict|erase [--sign] | update-me '<json>' | shortcut-token | credit-record '<json>'",
  ],
  tools: ["as <persona> say '<chat text>' [--conversation id]   (user message as the planner sees it; mints payee_N refs)", `tool <name> '<json>' --as <persona> [--conversation <id>|new] [--reader-output '<json>'|@file]  (names: ${TOOL_NAMES.join(", ")})`],
  demo: ["demo status | clock +1h|+1d|+3d|+Nh|+Nd | trigger <settlement|money-from-home|landlord-iban-email|pos-low-dough|cn-spending-day> | agent-mode <LIVE|REPLAY> | tick"],
  mock: [
    "mock inbox [messageId] | suppliers | catalog <supplierId> | price-list <supplierId> | payees | invoice <payeeId> [--variant swapped-account]",
    "mock qr <qrPaymentId> | qr-swap on|off | pos-emit [--sku S --level N --qty N] | remittance [--amount 400000 --currency KZT --sender text --profile li-wei] | outbox | transfers",
    "mock shop-menu | shop-checkout <cardId> [--amount minor | --items '<json>'] | shop-recharge <cardId> | charges",
  ],
  evidence: ["mark <name>", "evidence <scenario> [--since <marker>]", "report <scenario> --result PASS|FAIL --notes '<text>'|@file", "ledger-verify"],
};

function personaFlag(args: Args): PersonaFile {
  const name = flagStr(args, "as");
  if (!name) fail("BAD_ARGS", "this command needs --as <persona>");
  return loadPersona(name);
}

function conversationOf(p: PersonaFile, args: Args): string {
  const c = flagStr(args, "conversation");
  if (!c) return p.conversationId;
  return c === "new" ? randomUUID() : c;
}

function need(v: string | undefined, what: string): string {
  if (!v) fail("BAD_ARGS", `missing ${what}`);
  return v;
}

async function get(p: PersonaFile, path: string, what = `GET ${path}`) {
  return result(await personaRequest(p, "GET", path), what);
}

async function post(p: PersonaFile, path: string, body: unknown = {}, what = `POST ${path}`) {
  return result(await personaRequest(p, "POST", path, { body }), what);
}

function query(args: Args, keys: string[]): string {
  const q = new URLSearchParams();
  for (const k of keys) {
    const v = flagStr(args, k);
    if (v !== undefined) q.set(k, v);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

async function personaAction(p: PersonaFile, action: string | undefined, rest: string[], args: Args): Promise<unknown> {
  const arg = rest[0];
  switch (action) {
    case "me":
      return get(p, "/me");
    case "balances":
      return get(p, "/balances");
    case "budgets":
      return get(p, `/budgets${query(args, ["category"])}`);
    case "obligations":
      return get(p, "/obligations");
    case "forecast":
      return get(p, "/forecast");
    case "cards":
      return get(p, "/cards");
    case "fees":
      return get(p, "/cards/fees");
    case "transactions":
      return get(p, `/transactions${query(args, ["cursor", "limit"])}`);
    case "payees":
      return get(p, "/payees");
    case "mandates":
      return get(p, "/mandates");
    case "caps":
      return get(p, "/caps");
    case "rule-changes":
      return get(p, `/rule-changes${query(args, ["status"])}`);
    case "notifications":
      return get(p, `/notifications${query(args, ["limit"])}`);
    case "read-notification":
      return post(p, `/notifications/${need(arg, "notificationId")}/read`);
    case "ledger":
      return get(p, `/ledger${query(args, ["cursor", "limit"])}`);
    case "proposals":
      return get(p, `/proposals${query(args, ["status", "limit"])}`);
    case "add-payee":
      return post(p, "/payees", await jsonArg(arg, "payee JSON {name, kind, account, country, currency}"));
    case "verify-payee":
      return post(p, `/payees/${need(arg, "payeeId")}/verify-callback`);
    case "create-mandate":
      return createMandate(p, (await jsonArg(arg, "mandate JSON {payeeIds, categories, currency, maxPerPaymentMinor, maxPerPeriodMinor, period, validUntil}")) as Record<string, unknown>);
    case "revoke-mandate":
      return post(p, `/mandates/${need(arg, "mandateId")}/revoke`);
    case "settings": {
      if (arg === "get") {
        const [me, caps, changes] = [await get(p, "/me"), await get(p, "/caps"), await get(p, "/rule-changes?status=all")];
        return { ok: true, me: me.data, caps: caps.data, ruleChanges: changes.data };
      }
      if (arg === "patch") return gated(p, "PATCH", "/settings", (await jsonArg(rest[1], "settings patch JSON")) as Record<string, unknown>, flagBool(args, "sign"), "PATCH /settings");
      return fail("BAD_ARGS", "settings get | settings patch '<json>' [--sign]");
    }
    case "freeze":
      return post(p, "/freeze");
    case "unfreeze":
      return gated(p, "POST", "/unfreeze", {}, flagBool(args, "sign"), "POST /unfreeze");
    case "order":
      return orderView(p, need(arg, "proposalId"));
    case "approve":
      return approve(p, need(arg, "proposalId"));
    case "reject": {
      const reason = flagStr(args, "reason");
      const r = await personaRequest(p, "POST", `/orders/${need(arg, "proposalId")}/reject`, { body: reason ? { reason } : {} });
      return result(r, "reject");
    }
    case "capture-event":
      return post(p, "/capture/event", await jsonArg(arg, "capture event JSON"));
    case "settlement":
      return post(p, "/capture/settlement", await jsonArg(arg, "settlement JSON"));
    case "upload": {
      const kind = flagStr(args, "kind");
      return upload(p, need(arg, "file"), { conversationId: conversationOf(p, args), ...(kind ? { kind } : {}) });
    }
    case "handoff":
      return get(p, `/handoff/${need(arg, "paymentId")}`);
    case "pay-qr":
      return payQr(p, need(arg, "paymentId"));
    case "payment": {
      const proposalId = flagStr(args, "proposal");
      return control("/payment", proposalId ? { proposalId } : { paymentId: need(arg, "paymentId (or --proposal <proposalId>)") }, await freshAccessToken(p));
    }
    case "intent":
      return post(p, `/payments/${need(arg, "paymentId")}/intent`);
    case "simulate-intent":
      return post(p, `/payments/${need(arg, "paymentId")}/intent/simulate-success`);
    case "shortcut-token":
      return post(p, "/devices/shortcut");
    case "credit-record":
      return post(p, "/credit-record/export", await jsonArg(arg, "credit record JSON {from, to}"));
    case "update-me":
      return result(await personaRequest(p, "PATCH", "/me", { body: await jsonArg(arg, "profile JSON {displayName}") }), "PATCH /me");
    case "privacy": {
      switch (arg) {
        case "notice":
          return get(p, "/privacy/ai-notice");
        case "export": {
          const r = await get(p, "/privacy/export");
          const out = flagStr(args, "out");
          if (out) {
            writeFileSync(out, `${JSON.stringify(r.data, null, 2)}\n`);
            return { ok: true, httpStatus: r.httpStatus, written: out };
          }
          return r;
        }
        case "consent":
          return result(await personaRequest(p, "POST", "/privacy/ai-consent", { body: { consent: !flagBool(args, "withdraw") }, consentRetry: false }), "POST /privacy/ai-consent");
        case "restrict":
          return post(p, "/privacy/restrict");
        case "erase":
          return gated(p, "POST", "/privacy/erase", { confirm: "ERASE" }, flagBool(args, "sign"), "POST /privacy/erase");
        default:
          return fail("BAD_ARGS", "privacy notice | export [--out file] | consent [--withdraw] | restrict | erase [--sign]");
      }
    }
    case "tool":
      return runTool(p, rest, args);
    case "say":
      return say(p, await textArg(arg, "message text"), conversationOf(p, args));
    default:
      return fail("BAD_ARGS", `unknown persona action "${action ?? ""}"`, { usage: USAGE.user });
  }
}

async function runTool(p: PersonaFile, rest: string[], args: Args) {
  const name = need(rest[0], "tool name");
  if (!TOOL_NAMES.includes(name)) fail("UNKNOWN_TOOL", `unknown tool ${name}`, { tools: TOOL_NAMES });
  const input = rest[1] === undefined ? {} : await jsonArg(rest[1], "tool input JSON");
  const ro = flagStr(args, "reader-output");
  return tool(p, name, input, { conversationId: conversationOf(p, args), ...(ro !== undefined ? { readerOutput: await jsonArg(ro, "--reader-output") } : {}) });
}

async function demoCmd(sub: string | undefined, rest: string[]) {
  switch (sub) {
    case "status":
    case undefined:
      return demo("GET", "/demo/clock");
    case "clock":
      return demo("POST", "/demo/clock/advance", { hours: parseHours(rest[0]) });
    case "trigger":
      return demo("POST", `/demo/trigger/${need(rest[0], "scenario")}`);
    case "agent-mode": {
      const mode = need(rest[0], "LIVE|REPLAY").toUpperCase();
      if (mode !== "LIVE" && mode !== "REPLAY") fail("BAD_ARGS", "agent-mode LIVE|REPLAY");
      return demo("POST", "/demo/agent-mode", { mode });
    }
    case "tick":
      return control("/tick");
    default:
      return fail("BAD_ARGS", "unknown demo command", { usage: USAGE.demo });
  }
}

async function mockCmd(sub: string | undefined, rest: string[], args: Args) {
  const arg = rest[0];
  switch (sub) {
    case "inbox":
      return mockGet(arg ? `/inbox/${encodeURIComponent(arg)}` : "/inbox");
    case "suppliers":
      return mockGet("/suppliers");
    case "catalog":
      return mockGet(`/suppliers/${encodeURIComponent(need(arg, "supplierId"))}/catalog`);
    case "price-list": {
      const id = need(arg, "supplierId");
      return mockPdf(`/suppliers/${encodeURIComponent(id)}/price-list.pdf`, `price-list-${id}.pdf`);
    }
    case "payees":
      return mockGet("/payees");
    case "invoice": {
      const id = need(arg, "payeeId (see: sim mock payees)");
      const variant = flagStr(args, "variant");
      return mockPdf(`/payees/${encodeURIComponent(id)}/invoice.pdf${variant ? `?variant=${encodeURIComponent(variant)}` : ""}`, `invoice-${id}${variant ? `-${variant}` : ""}.pdf`);
    }
    case "qr":
      return mockGet(`/qr/payments/${encodeURIComponent(need(arg, "qrPaymentId"))}`);
    case "qr-swap": {
      // A5 demo switch in the mock QR wallet: while on, every NEW QR request names another payee.
      if (arg !== "on" && arg !== "off") fail("BAD_ARGS", "mock qr-swap on|off");
      return mockPost("/qr/attack/swap", { enabled: arg === "on" });
    }
    case "pos-emit": {
      const qty = flagStr(args, "qty");
      return mockPost("/pos/emit", {
        sku: flagStr(args, "sku") ?? "DOUGH",
        level: Number(flagStr(args, "level") ?? 2),
        ...(qty !== undefined ? { requestedQuantity: Number(qty) } : {}),
      });
    }
    case "remittance":
      return mockPost("/remittance/incoming", {
        amount: flagStr(args, "amount") ?? "1000000",
        currency: flagStr(args, "currency") ?? "KZT",
        ...(flagStr(args, "sender") ? { sender: flagStr(args, "sender") } : {}),
        // Mock bank profile id or alias (user id, or "li-wei"); default: the demo user's wallet.
        ...(flagStr(args, "profile") ? { profileId: flagStr(args, "profile") } : {}),
      });
    case "outbox":
      return mockGet("/outbox");
    case "transfers":
      return mockGet("/bank/transfers");
    case "shop-menu":
      return mockGet("/shop/pizza/menu");
    case "charges":
      return mockGet("/shop/pizza/charges");
    case "shop-checkout":
    case "shop-recharge": {
      const cardId = need(arg, "cardId (from: sim as <persona> payment <paymentId>)");
      const amount = flagStr(args, "amount");
      const items = flagStr(args, "items");
      let body: Record<string, unknown> = { cardId };
      if (amount) body = { ...body, amountMinor: Number(amount) };
      else if (items) body = { ...body, items: await jsonArg(items, "--items") };
      else {
        // Default basket: the first menu item, twice (read from the shop, never hardcoded).
        const menu = (await mockGet("/shop/pizza/menu")).data as { items: { sku: string }[] };
        const first = menu.items[0];
        if (!first) fail("MOCK_ERROR", "shop menu is empty");
        body = { ...body, items: [{ sku: first.sku, quantity: 2 }] };
      }
      return { action: sub === "shop-recharge" ? "second charge on the same one-time card" : "checkout", ...(await mockPost("/shop/pizza/checkout", body)) };
    }
    default:
      return fail("BAD_ARGS", "unknown mock command", { usage: USAGE.mock });
  }
}

async function main(argv: string[]): Promise<unknown> {
  const args = parseArgs(argv);
  const [cmd, ...rest] = args._;
  switch (cmd) {
    case undefined:
    case "help":
      return { usage: USAGE };
    case "up":
      return up({ fresh: flagBool(args, "fresh"), scheduler: flagBool(args, "scheduler"), liveFx: flagBool(args, "live-fx") });
    case "down":
      return down();
    case "status":
      return status();
    case "logs":
      return logs(Number(flagStr(args, "tail") ?? 50));
    case "reset": {
      const r = await demo("POST", "/demo/reset");
      // Reset truncates every table (credentials included): stored personas are no longer valid.
      const cleared = listPersonas();
      rmSync(FILES.personas, { recursive: true, force: true });
      removeFile(FILES.markers);
      return { ...r, personasCleared: cleared, next: "register personas again (the demo user: sim register <name> --claim-demo)" };
    }
    case "register": {
      const name = need(rest[0], "persona name");
      const { persona, session } = await registerPersona(name, {
        claimDemo: flagStr(args, "claim-demo") ?? flagBool(args, "claim-demo"),
        force: flagBool(args, "force"),
        aiConsent: !flagBool(args, "no-ai-consent"),
      });
      const onboarding = flagBool(args, "no-onboard") || session.onboarded ? null : await onboard(persona, { noMandate: flagBool(args, "no-mandate") });
      return { ok: true, persona: persona.name, userId: persona.userId, displayName: persona.displayName, conversationId: persona.conversationId, onboarding };
    }
    case "login": {
      const p = loadPersona(need(rest[0], "persona name"));
      const s = await loginPersona(p);
      return { ok: true, persona: p.name, userId: s.user.id, onboarded: s.onboarded };
    }
    case "onboard":
      return { ok: true, ...(await onboard(loadPersona(need(rest[0], "persona name")), { noMandate: flagBool(args, "no-mandate") })) };
    case "personas":
      return { personas: listPersonas().map((n) => ({ name: n, userId: loadPersona(n).userId })) };
    case "as": {
      const p = loadPersona(need(rest[0], "persona name"));
      return personaAction(p, rest[1], rest.slice(2), args);
    }
    case "tool":
      return runTool(personaFlag(args), rest, args);
    case "tools":
      return { tools: TOOL_NAMES };
    case "demo":
      return demoCmd(rest[0], rest.slice(1));
    case "mock":
      return mockCmd(rest[0], rest.slice(1), args);
    case "mark":
      return mark(need(rest[0], "marker name"));
    case "evidence": {
      const since = flagStr(args, "since");
      return evidence(need(rest[0], "scenario id"), since ? { since } : {});
    }
    case "report": {
      const res = need(flagStr(args, "result"), "--result PASS|FAIL");
      const notesRaw = flagStr(args, "notes");
      return report(need(rest[0], "scenario id"), { result: res, notes: notesRaw ? await textArg(notesRaw, "--notes") : "" });
    }
    case "ledger-verify":
      return ledgerVerify();
    default:
      return fail("BAD_ARGS", `unknown command "${cmd}"`, { usage: USAGE });
  }
}

try {
  print(await main(process.argv.slice(2)));
  process.exit(0);
} catch (e) {
  printError(e);
  process.exit(1);
}
