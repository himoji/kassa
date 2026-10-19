/*
 * The answer of last resort: when the planner could not finish a turn in its time budget (budget.ts) and the final
 * answer step failed too, code writes a short summary of what the tools found and of any proposal created, so the
 * user never gets silence. Inputs are tool outputs as the model saw them (redacted, payees as payee_N); the text is
 * written in that redacted form, stored as such, and rehydrated for the user by the stream (loop.ts).
 */

export interface ToolOutcome {
  toolName: string;
  output: unknown;
}

export interface ProposalOutcome {
  /** Redacted (payees as placeholders). */
  summary: string;
  decision: string;
  reasonCodes: readonly string[];
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec).filter((x): x is Rec => x !== null) : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

const MAX_ITEMS = 5;

const DECISION_TEXT: Record<string, string> = {
  AUTO: "approved automatically within your limits",
  ASK: "waiting for your approval with your passkey",
  HANDOFF: "needs your attention before it can go ahead",
  REFUSE: "refused, no money was sent",
};

const TOOL_TEXT: Record<string, string> = {
  get_profile_summary: "your profile",
  get_budget: "your budgets",
  get_payee_facts: "the payee's verification",
  search_catalog: "the shop's catalog",
  get_spending_summary: "your spending",
  get_money_history: "your money history",
  get_payments: "your payments",
  read_document: "the document",
  log_expense: "the expense log",
  get_fx_rate: "exchange rates",
  get_inventory: "your inventory",
  forecast_stock: "your stock forecast",
};

function obligations(out: Rec): string[] {
  return arr(out.obligations)
    .slice(0, MAX_ITEMS)
    .map((o) => {
      const amount = str(o.amount) ?? `${String(o.amountMinor)} ${String(o.currency)} (minor units)`;
      const home = str(o.homeAmount);
      const what = str(o.category) ?? "bill";
      return `${what} ${amount}${home && !home.startsWith(String(o.currency)) ? ` (≈ ${home})` : ""} to ${str(o.payeeRef) ?? "a payee"}, due ${str(o.dueDate) ?? "soon"}`;
    });
}

function balances(out: Rec): string | null {
  const rows = arr(out.balances)
    .map((b) => str(b.amount))
    .filter((x): x is string => x !== null);
  if (rows.length === 0) return null;
  const total = str(out.homeTotal);
  return `Balances: ${rows.join(", ")}${total ? ` (total ≈ ${total})` : ""}.`;
}

function routes(out: Rec): string | null {
  const best = arr(out.routes)[0];
  const parts: string[] = [];
  if (best) {
    const cost = str(best.costHome);
    parts.push(`Cheapest way to pay ${str(out.amount) ?? "it"}: ${str(best.label) ?? "the first route"} from ${str(best.fundingCurrency) ?? "your balance"}${cost ? `, total cost ≈ ${cost}` : ""}${best.balanceCovers === false ? " (that balance does not cover it today)" : ""}.`);
  }
  const caps = arr(out.maxPayable)
    .map((m) => (str(m.maxAmount) && str(m.fundingCurrency) ? `${str(m.fundingCurrency)} balance pays up to ${str(m.maxAmount)}` : null))
    .filter((x): x is string => x !== null);
  if (caps.length > 0) parts.push(`Most each balance can pay today: ${caps.slice(0, MAX_ITEMS).join("; ")}.`);
  return parts.length > 0 ? parts.join(" ") : null;
}

function coverage(out: Rec): string | null {
  const short = arr(out.currencies)
    .filter((c) => rec(c.shortfall))
    .map((c) => {
      const s = rec(c.shortfall)!;
      return `${str(c.currency) ?? "?"} short ${str(s.amount) ?? String(s.amountMinor)} by ${str(s.date) ?? "?"}`;
    });
  if (arr(out.currencies).length === 0) return null;
  return short.length > 0 ? `Coverage forecast: ${short.slice(0, MAX_ITEMS).join("; ")}.` : "Coverage forecast: no currency runs short in the next weeks.";
}

/** A plain-text answer from what the turn's tools returned (redacted form). */
export function fallbackAnswer(tools: readonly ToolOutcome[], proposals: readonly ProposalOutcome[], o: { timedOut: boolean }): string {
  const lines: string[] = [];
  for (const p of proposals) {
    const decision = DECISION_TEXT[p.decision] ?? p.decision;
    const why = p.reasonCodes.length > 0 ? ` (${p.reasonCodes.join(", ")})` : "";
    lines.push(`- Payment proposal: ${p.summary.replace(/\.$/, "")}. Status: ${decision}${why}. Its card is shown here.`);
  }
  // The latest output of each tool is the one that counts (the planner may have asked twice).
  const latest = new Map<string, Rec>();
  for (const t of tools) {
    const out = rec(t.output);
    if (out && !("error" in out)) latest.set(t.toolName, out);
  }
  const other: string[] = [];
  for (const [name, out] of latest) {
    if (name === "get_obligations") {
      const rows = obligations(out);
      if (rows.length > 0) lines.push(`- Upcoming bills: ${rows.join("; ")}.`);
    } else if (name === "get_balances") {
      const b = balances(out);
      if (b) lines.push(`- ${b}`);
    } else if (name === "get_routes") {
      const r = routes(out);
      if (r) lines.push(`- ${r}`);
    } else if (name === "forecast_coverage") {
      const c = coverage(out);
      if (c) lines.push(`- ${c}`);
    } else if (name !== "propose_order" && !name.startsWith("ask_")) {
      other.push(TOOL_TEXT[name] ?? name.replace(/_/g, " "));
    }
  }
  if (other.length > 0) lines.push(`- I also checked ${other.join(", ")}.`);
  if (lines.length === 0) {
    return o.timedOut
      ? "Sorry, I could not finish this answer in time, and no payment was made. Please ask again, or ask for one thing at a time."
      : "Sorry, I could not write an answer this time, and no payment was made. Please ask again.";
  }
  const intro = o.timedOut ? "I ran out of time before I could finish my answer. Here is what I found so far:" : "Here is what I found:";
  return [intro, ...lines, "Ask me again for the details or the next step."].join("\n");
}
