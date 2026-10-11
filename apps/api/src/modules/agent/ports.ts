import { and, asc, eq, gte, lte } from "drizzle-orm";

import type { BudgetDto, BudgetImpact, CaptureEventResponse, ForecastResponse, ProposalSummary, RouteDto } from "@kassa/shared";

import { getDb } from "../../db/client.ts";
import { obligations, payees, profiles, proposals, users, type IncomeJson } from "../../db/schema.ts";
import { budgetImpact, listBudgets } from "../budget/index.ts";
import { ingestCapture, type CaptureInput } from "../capture/index.ts";
import { clock, isoDate } from "../clock/index.ts";
import { addDays } from "../fx/dates.ts";
import { forecastCoverage, getBalances, getRoutes, toHome } from "../fx/index.ts";
import { accountHash } from "../payees/crypto.ts";
import { readDocument, type ReaderResult } from "../reader/index.ts";
import { payeeHistory } from "../rules/facts.ts";
import { proposeOrder, type ProposeOrderInput, type ProposeOrderResult } from "../rules/index.ts";

/*
 * Everything the planner's tools can touch, as one interface. The DB implementation below is the only
 * place agent code reaches data; tests substitute fakes. The single write is `proposeOrder` (I1):
 * rules decide; nothing here can approve or execute a payment.
 */

export interface PayeeRow {
  id: string;
  name: string;
  kind: string;
  status: "VERIFIED" | "COOLING" | "BLOCKED";
  verifiedAt: string | null;
  coolingUntil: string | null;
  accountHash: string;
  replacesPayeeId: string | null;
}

export interface ObligationRow {
  id: string;
  payeeId: string;
  amountMinor: number;
  currency: string;
  dueDate: string;
  recurrence: string;
  reference: string | null;
  category: string;
}

export interface ProfileRow {
  displayName: string;
  homeCurrency: string;
  region: string;
  preset: string;
  moneyMode: string;
  notificationMode: string;
  incomes: IncomeJson[];
}

export interface AgentPorts {
  userId: string;
  conversationId: string;
  profile(): Promise<ProfileRow>;
  payees(): Promise<PayeeRow[]>;
  balances(): Promise<Array<{ currency: string; amountMinor: number }>>;
  toHome(amountMinor: number, currency: string): Promise<number>;
  budgets(category?: string): Promise<BudgetDto[]>;
  obligations(withinDays?: number): Promise<ObligationRow[]>;
  paymentCount(payeeId: string): Promise<number>;
  catalog(merchant: string, query: string): Promise<unknown>;
  routes(a: { fromCurrency?: string; toCurrency: string; amountMinor: number; dueDate?: string }): Promise<{ homeCurrency: string; routes: RouteDto[] }>;
  forecast(): Promise<ForecastResponse>;
  readDocument(docId: string): Promise<ReaderResult>;
  accountHashOf(account: string): string;
  /** THE write path (I1). */
  proposeOrder(input: ProposeOrderInput): Promise<ProposeOrderResult>;
  proposalCard(proposalId: string): Promise<{ summary: ProposalSummary | null; budgetImpact: BudgetImpact | null }>;
  logExpense(input: CaptureInput): Promise<CaptureEventResponse>;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function dbPorts(userId: string, conversationId: string): AgentPorts {
  const db = getDb();
  return {
    userId,
    conversationId,
    async profile() {
      const u = (await db.select().from(users).where(eq(users.id, userId)))[0];
      if (!u) throw new Error("user not found");
      const p = (await db.select().from(profiles).where(eq(profiles.userId, userId)))[0];
      return {
        displayName: u.displayName,
        homeCurrency: u.homeCurrency,
        region: u.region,
        preset: u.preset,
        moneyMode: u.moneyMode,
        notificationMode: p?.notificationMode ?? "EACH",
        incomes: p?.incomes ?? [],
      };
    },
    async payees() {
      const rows = await db.select().from(payees).where(eq(payees.userId, userId));
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        status: r.status,
        verifiedAt: iso(r.verifiedAt),
        coolingUntil: iso(r.coolingUntil),
        accountHash: r.accountHash,
        replacesPayeeId: r.replacesPayeeId,
      }));
    },
    balances: () => getBalances(userId),
    async toHome(amountMinor, currency) {
      const p = await this.profile();
      return (await toHome(amountMinor, currency, p.homeCurrency, clock.now())).amountMinor;
    },
    async budgets(category) {
      return (await listBudgets(userId, category)).budgets;
    },
    async obligations(withinDays) {
      const today = isoDate(clock.now());
      const rows = await db
        .select()
        .from(obligations)
        .where(and(eq(obligations.userId, userId), gte(obligations.dueDate, today), withinDays ? lte(obligations.dueDate, addDays(today, withinDays)) : undefined))
        // Deterministic order → deterministic payee_N placeholders (replay recordings rely on it).
        .orderBy(asc(obligations.dueDate), asc(obligations.id));
      return rows.map((o) => ({
        id: o.id,
        payeeId: o.payeeId,
        amountMinor: o.amountMinor,
        currency: o.currency,
        dueDate: o.dueDate,
        recurrence: o.recurrence,
        reference: o.reference,
        category: o.category,
      }));
    },
    async paymentCount(payeeId) {
      return (await payeeHistory(db, userId, payeeId)).count;
    },
    async catalog(merchant, query) {
      const base = `${process.env.MOCK_WORLD_URL ?? "http://localhost:4001"}/mock`;
      const id = merchant.toLowerCase().replace(/[^a-z0-9-]/g, "");
      const url = id === "pizza" || id === "pizza-shop" || id === "pizzashop" ? `${base}/shop/pizza/menu` : `${base}/suppliers/${encodeURIComponent(id)}/catalog`;
      const res = await fetch(url);
      if (!res.ok) return { error: "CATALOG_NOT_FOUND", merchant };
      const body = (await res.json()) as { currency?: string; items?: Array<Record<string, unknown>> };
      const q = query.toLowerCase();
      // Structured fields only: free-text notes from a merchant are untrusted (I10) and are dropped.
      const items = (body.items ?? [])
        .map((i) => ({
          sku: typeof i.sku === "string" ? i.sku : typeof i.id === "string" ? i.id : undefined,
          name: String(i.name ?? "").slice(0, 80),
          unitPriceMinor: Number(i.unitPriceMinor ?? i.priceMinor ?? NaN),
          currency: String(i.currency ?? body.currency ?? ""),
        }))
        .filter((i) => Number.isSafeInteger(i.unitPriceMinor) && (q === "*" || i.name.toLowerCase().includes(q) || (i.sku ?? "").toLowerCase().includes(q)));
      return { merchant: id, currency: body.currency ?? null, items: items.slice(0, 25) };
    },
    async routes(a) {
      const r = await getRoutes({ userId, ...a });
      return { homeCurrency: r.homeCurrency, routes: r.routes.map(({ amountInFundingMinor: _a, totalDebitFundingMinor: _t, ...dto }) => dto) };
    },
    forecast: () => forecastCoverage(userId),
    readDocument: (docId) => readDocument(docId, { userId }),
    accountHashOf: (account) => accountHash(account),
    proposeOrder: (input) => proposeOrder(input),
    async proposalCard(proposalId) {
      const p = (await db.select().from(proposals).where(and(eq(proposals.id, proposalId), eq(proposals.userId, userId))))[0];
      if (!p) return { summary: null, budgetImpact: null };
      const u = (await db.select().from(users).where(eq(users.id, userId)))[0]!;
      const payee = (await db.select({ name: payees.name }).from(payees).where(eq(payees.id, p.draft.payeeId)))[0];
      const homeAmountMinor = p.canonicalOrder?.homeAmountMinor ?? (await toHome(p.draft.amountMinor, p.draft.currency, u.homeCurrency, clock.now())).amountMinor;
      const summary: ProposalSummary = {
        proposalId: p.id,
        createdBy: p.createdBy,
        decision: p.decision,
        reasonCodes: p.reasonCodes,
        riskScore: Math.min(1, Math.max(0, p.riskScore)),
        status: p.status,
        payeeName: p.canonicalOrder?.payeeName ?? payee?.name ?? "Unknown payee",
        amountMinor: p.draft.amountMinor,
        currency: p.draft.currency,
        homeAmountMinor,
        homeCurrency: u.homeCurrency,
        createdAt: p.createdAt.toISOString(),
      };
      const impact = p.decision === "REFUSE" ? null : await budgetImpact(userId, p.category, homeAmountMinor);
      return { summary, budgetImpact: impact };
    },
    logExpense: (input) => ingestCapture(userId, input),
  };
}
