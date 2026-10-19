import { and, asc, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";

import { categoryOfKind, orderFunding, orderLineEn, suggestedReference, type BudgetDto, type CanonicalOrder, type ImportHistory, type BudgetImpact, type CaptureEventResponse, type ForecastResponse, type ProposalSummary, type RouteDto } from "@kassa/shared";

import { getDb } from "../../db/client.ts";
import { obligations, payees, profiles, proposals, users, type IncomeJson } from "../../db/schema.ts";
import { PROFILE_CORE } from "../../db/profile-columns.ts";
import { agentDocuments } from "../../db/schema.intel.ts";
import { budgetImpact, listBudgets, spendContext, type SpendContext } from "../budget/index.ts";
import { draftPurchaseOrder, type DraftLineInput, type DraftResult } from "../business/drafts.ts";
import type { Forecast } from "../business/forecast.ts";
import { loadForecast } from "../business/forecastData.ts";
import { merchantOfOwner } from "../business/queries.ts";
import { ingestCapture, type CaptureInput } from "../capture/index.ts";
import { clock, isoDate } from "../clock/index.ts";
import { addDays } from "../fx/dates.ts";
import { forecastCoverage, getBalances, getRoutes, toHome } from "../fx/index.ts";
import { getRoutes as rankRoutes } from "../fx/routes.ts";
import { billRail, coverageOf, type Coverage } from "../obligations/coverage.ts";
import { accountHash, readDetails } from "../payees/crypto.ts";
import { walletBalances } from "../rules/facts.ts";
import { loadUser } from "../users/service.ts";
import { readDocument, type ReaderResult } from "../reader/index.ts";
import { payeeHistory } from "../rules/facts.ts";
import { proposeConversion, proposeOrder, type ProposeConversionInput, type ProposeOrderInput, type ProposeOrderResult } from "../rules/index.ts";
import { maxPayablePerRoute } from "./capacity.ts";

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
  /** null = no account details yet (payee captured in onboarding; never payable). */
  accountHash: string | null;
  replacesPayeeId: string | null;
  /** (added 2026-10-15) Recipient category (shared/recipient.ts) and the payment reference its details suggest. */
  category?: string;
  suggestedReference?: string;
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
  /** What the user's imported statements showed (dataport/history.ts), or null before any import. */
  moneyHistory?: ImportHistory | null;
  /** (M5) "BUSINESS" turns on the business tool set and prompt section. */
  accountType?: "PERSONAL" | "BUSINESS";
}

/**
 * (added 2026-10-15, Business M5) The owner's merchant: stock forecast and purchase-order DRAFTS. A draft moves no
 * money (business/drafts.ts); signing, sending and paying are not reachable from here.
 */
export interface BusinessPorts {
  merchant(): Promise<{ id: string; currency: string; timezone: string; poCapMinor: number } | null>;
  forecast(): Promise<Forecast>;
  draftPurchaseOrder(input: { supplierPayeeId: string; currency: string; lines: DraftLineInput[] }): Promise<DraftResult>;
}

/** Catalog lookup result: items on success; `error` (and no items) when the merchant has no catalog. */
export interface CatalogLookup {
  error?: string;
  merchant?: string;
  /** The merchant's display name from its catalog; matched to a payee by normalised name. */
  merchantName?: string | null;
  currency?: string | null;
  items?: Array<{ sku: string | undefined; name: string; unitPriceMinor: number; currency: string }>;
  /** (M2) Set when the catalog is a shop's storefront (mock-world storeId): its orders are delivered by the shop. */
  storeId?: string;
}

/** One funding route's ceiling: the most of the bill currency it pays from `balanceMinor` (fundingCurrency). */
export interface MaxPayableRow {
  routeId: string;
  label: string;
  fundingCurrency: string;
  balanceMinor: number;
  maxAmountMinor: number;
}

export interface AgentPorts {
  userId: string;
  conversationId: string;
  profile(): Promise<ProfileRow>;
  payees(): Promise<PayeeRow[]>;
  balances(): Promise<Array<{ currency: string; amountMinor: number }>>;
  toHome(amountMinor: number, currency: string): Promise<number>;
  budgets(category?: string): Promise<BudgetDto[]>;
  /** Upcoming bills (due today or later). `includePast` also returns past-due ones (B4: linking an order to its period). */
  obligations(withinDays?: number, opts?: { includePast?: boolean }): Promise<ObligationRow[]>;
  paymentCount(payeeId: string): Promise<number>;
  catalog(merchant: string, query: string): Promise<CatalogLookup>;
  /**
   * (Y5) Catalog ids with their merchant names (pizza shops + suppliers), to map a payee placeholder to its catalog.
   * (M2) Storefronts carry their storeId.
   */
  catalogDirectory?(): Promise<Array<{ id: string; name: string; storeId?: string }>>;
  routes(a: { fromCurrency?: string; toCurrency: string; amountMinor: number; dueDate?: string }): Promise<{ homeCurrency: string; routes: RouteDto[] }>;
  /**
   * The largest bill in `toCurrency` each funding route can pay from today's balance (capacity.ts), so the planner
   * never probes get_routes with guessed amounts. Optional: without it get_routes answers routes only.
   */
  maxPayable?(a: { toCurrency: string; dueDate?: string }): Promise<MaxPayableRow[]>;
  /**
   * (added 2026-10-18) Coverage of these bills, the same answer GET /obligations gives (obligations/coverage.ts):
   * COVERED, CONVERTIBLE with its conversion plan, SHORTFALL or UNKNOWN. Optional: fakes may leave it out.
   */
  obligationCoverage?(obligationIds: string[]): Promise<Map<string, Coverage>>;
  forecast(): Promise<ForecastResponse>;
  /** This month's spending per category, budgeted or not, against a usual month and monthly income (budget/context.ts). */
  spending(): Promise<SpendContext>;
  readDocument(docId: string): Promise<ReaderResult>;
  /**
   * Persisted Reader results of this user's documents (I10, B1), independent of turn and conversation.
   * With `docIds`: only those of the user's documents (null = uploaded but never read; unknown ids absent).
   * Without: every document of the user that has been read.
   */
  storedReads(docIds?: string[]): Promise<Map<string, ReaderResult | null>>;
  accountHashOf(account: string): string;
  /** THE write path (I1). */
  proposeOrder(input: ProposeOrderInput): Promise<ProposeOrderResult>;
  /**
   * (added 2026-10-18) A CONVERT order between the user's own balances (rules.proposeConversion: always ASK, the passkey
   * signs it). Optional so fakes without it answer CONVERT_UNAVAILABLE.
   */
  proposeConversion?(input: ProposeConversionInput): Promise<ProposeOrderResult>;
  proposalCard(proposalId: string): Promise<{ summary: ProposalSummary | null; budgetImpact: BudgetImpact | null }>;
  logExpense(input: CaptureInput): Promise<CaptureEventResponse>;
  /** (M5) Present for the DB implementation; the tools use it only when the profile is a BUSINESS account. */
  business?: BusinessPorts;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * A document uploaded without a conversationId belongs to the first conversation that reads it, so later
 * turns of that conversation load it with the other documents read there (agent/store.ts readDocs).
 */
export async function bindToConversation(userId: string, docId: string, conversationId: string): Promise<void> {
  await getDb()
    .update(agentDocuments)
    .set({ conversationId })
    .where(and(eq(agentDocuments.id, docId), eq(agentDocuments.userId, userId), isNull(agentDocuments.conversationId)));
}

/** Catalog ids that name a shop's storefront → mock-world storeId. */
const STOREFRONT_IDS: Record<string, string> = { pizza: "bud", "pizza-shop": "bud", pizzashop: "bud", bud: "bud", sha: "sha", "pizza-shop-sh": "sha" };

/** (2026-10-18) The signed funding binding and the one-sentence signed order, for the proposal card. */
function cardFunding(order: CanonicalOrder | null): Pick<ProposalSummary, "funding" | "orderLine"> {
  if (!order) return {};
  let f: ReturnType<typeof orderFunding> = null;
  try {
    f = orderFunding(order);
  } catch {
    f = null;
  }
  return {
    ...(f ? { funding: { currency: f.currency, maxAmountMinor: f.maxAmountMinor, routeId: f.routeId, markupBps: f.markupBps } } : {}),
    orderLine: orderLineEn(order),
  };
}

export function dbPorts(userId: string, conversationId: string): AgentPorts {
  const db = getDb();
  return {
    userId,
    conversationId,
    async profile() {
      const u = (await db.select().from(users).where(eq(users.id, userId)))[0];
      if (!u) throw new Error("user not found");
      const p = (await db.select(PROFILE_CORE).from(profiles).where(eq(profiles.userId, userId)))[0];
      // The imported history is optional: a database without its column (not migrated yet) answers without it.
      const moneyHistory = await db
        .select({ h: profiles.moneyHistory })
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .then((r) => r[0]?.h ?? null)
        .catch(() => null);
      return {
        displayName: u.displayName,
        homeCurrency: u.homeCurrency,
        region: u.region,
        preset: u.preset,
        moneyMode: u.moneyMode,
        notificationMode: p?.notificationMode ?? "EACH",
        incomes: p?.incomes ?? [],
        moneyHistory,
        accountType: u.accountType,
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
        category: categoryOfKind(r.kind),
        // Only references a school, landlord or biller matches payments by; a note to a person is the planner's call.
        suggestedReference: categoryOfKind(r.kind) === "PEOPLE" || categoryOfKind(r.kind) === "SHOPS" ? "" : suggestedReference(readDetails(r)),
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
    async obligations(withinDays, opts) {
      const today = isoDate(clock.now());
      const rows = await db
        .select()
        .from(obligations)
        .where(
          and(
            eq(obligations.userId, userId),
            opts?.includePast ? undefined : gte(obligations.dueDate, today),
            withinDays ? lte(obligations.dueDate, addDays(today, withinDays)) : undefined,
          ),
        )
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
    async obligationCoverage(ids) {
      const out = new Map<string, Coverage>();
      if (ids.length === 0) return out;
      const u = (await db.select({ homeCurrency: users.homeCurrency, preset: users.preset, overrides: users.overrides, region: users.region }).from(users).where(eq(users.id, userId)))[0];
      if (!u) return out;
      const rows = await db
        .select({ id: obligations.id, amountMinor: obligations.amountMinor, currency: obligations.currency, dueDate: obligations.dueDate, payeeKind: payees.kind, payeeAccountHash: payees.accountHash })
        .from(obligations)
        .innerJoin(payees, eq(payees.id, obligations.payeeId))
        .where(and(eq(obligations.userId, userId), inArray(obligations.id, ids)));
      const balances = await walletBalances(userId);
      const reserveHomeMinor = (await loadUser(db, userId)).caps.reserveMinor;
      const now = clock.now();
      for (const o of rows) {
        try {
          out.set(o.id, await coverageOf(o, { userId, homeCurrency: u.homeCurrency, now, balances, rail: billRail(u, o.payeeKind), reserveHomeMinor }));
        } catch {
          out.set(o.id, { coverage: "UNKNOWN", bestRoute: null });
        }
      }
      return out;
    },
    async paymentCount(payeeId) {
      return (await payeeHistory(db, userId, payeeId)).count;
    },
    async catalogDirectory() {
      const base = `${process.env.MOCK_WORLD_URL ?? "http://localhost:4001"}/mock`;
      const out: Array<{ id: string; name: string; storeId?: string }> = [];
      // The Budapest shop keeps its original catalog id "pizza"; (M2) the Shanghai shop is "sha".
      for (const [id, storeId] of [["pizza", "bud"], ["sha", "sha"]] as const) {
        const menu = await fetch(`${base}/shop/${storeId}/menu`).catch(() => null);
        if (!menu?.ok) continue;
        const name = ((await menu.json()) as { merchant?: { name?: unknown } }).merchant?.name;
        if (typeof name === "string") out.push({ id, name, storeId });
      }
      const sup = await fetch(`${base}/suppliers`).catch(() => null);
      if (sup?.ok) {
        for (const x of ((await sup.json()) as { suppliers?: Array<{ id?: unknown; name?: unknown }> }).suppliers ?? []) {
          if (typeof x.id === "string" && typeof x.name === "string") out.push({ id: x.id, name: x.name });
        }
      }
      return out;
    },
    async catalog(merchant, query) {
      const base = `${process.env.MOCK_WORLD_URL ?? "http://localhost:4001"}/mock`;
      const id = merchant.toLowerCase().replace(/[^a-z0-9-]/g, "");
      // Storefronts (M2): the Budapest shop ("pizza", "bud") and the Shanghai shop ("sha"); else a supplier catalog.
      const store = STOREFRONT_IDS[id];
      const url = store ? `${base}/shop/${store}/menu` : `${base}/suppliers/${encodeURIComponent(id)}/catalog`;
      const res = await fetch(url);
      if (!res.ok) return { error: "CATALOG_NOT_FOUND", merchant };
      const body = (await res.json()) as { currency?: string; items?: Array<Record<string, unknown>>; merchant?: { name?: unknown; storeId?: unknown }; supplier?: { name?: unknown } };
      const q = query.toLowerCase();
      // The merchant's display name (pizza `merchant.name`, supplier `supplier.name`) is matched to a payee by the tools.
      const merchantName = typeof body.merchant?.name === "string" ? body.merchant.name : typeof body.supplier?.name === "string" ? body.supplier.name : null;
      // Structured fields only: free-text notes from a merchant are untrusted (I10) and are dropped.
      const items = (body.items ?? [])
        .map((i) => ({
          sku: typeof i.sku === "string" ? i.sku : typeof i.id === "string" ? i.id : undefined,
          name: String(i.name ?? "").slice(0, 80),
          unitPriceMinor: Number(i.unitPriceMinor ?? i.priceMinor ?? NaN),
          currency: String(i.currency ?? body.currency ?? ""),
        }))
        .filter((i) => Number.isSafeInteger(i.unitPriceMinor) && (q === "*" || i.name.toLowerCase().includes(q) || (i.sku ?? "").toLowerCase().includes(q)));
      const storeId = store && typeof body.merchant?.storeId === "string" ? body.merchant.storeId : undefined;
      return { merchant: id, merchantName, currency: body.currency ?? null, items: items.slice(0, 25), ...(storeId ? { storeId } : {}) };
    },
    async routes(a) {
      const r = await getRoutes({ userId, ...a });
      return { homeCurrency: r.homeCurrency, routes: r.routes.map(({ amountInFundingMinor: _a, totalDebitFundingMinor: _t, ...dto }) => dto) };
    },
    async maxPayable({ toCurrency, dueDate }) {
      const [{ homeCurrency }, balances] = await Promise.all([this.profile(), getBalances(userId)]);
      const today = isoDate(clock.now());
      const out: MaxPayableRow[] = [];
      for (const b of balances) {
        // The optimizer without its balance cap, for this funding currency only; the cap is applied by the search.
        const priced = (amountMinor: number) =>
          rankRoutes({ amountMinor, toCurrency, homeCurrency, today, dueDate, balances: [{ currency: b.currency, amountMinor: Number.MAX_SAFE_INTEGER }], top: Number.MAX_SAFE_INTEGER });
        const labels = new Map((await priced(1)).map((r) => [r.routeId, r.label]));
        for (const [routeId, maxAmountMinor] of await maxPayablePerRoute(priced, b.amountMinor)) {
          out.push({ routeId, label: labels.get(routeId) ?? routeId, fundingCurrency: b.currency, balanceMinor: b.amountMinor, maxAmountMinor });
        }
      }
      return out;
    },
    forecast: () => forecastCoverage(userId),
    spending: () => spendContext(userId, "other"),
    async readDocument(docId) {
      const r = await readDocument(docId, { userId });
      await bindToConversation(userId, docId, conversationId);
      return r;
    },
    async storedReads(docIds) {
      if (docIds && docIds.length === 0) return new Map();
      const rows = await db
        .select({ id: agentDocuments.id, r: agentDocuments.readerResult })
        .from(agentDocuments)
        .where(and(eq(agentDocuments.userId, userId), docIds ? inArray(agentDocuments.id, docIds) : isNotNull(agentDocuments.readerResult)));
      return new Map(rows.map((x) => [x.id, (x.r as unknown as ReaderResult | null) ?? null]));
    },
    accountHashOf: (account) => accountHash(account),
    proposeOrder: (input) => proposeOrder(input),
    proposeConversion: (input) => proposeConversion(input),
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
        ...(p.canonicalOrder?.rail === "CONVERT" || p.draft.rail === "CONVERT" ? { kind: "CONVERT" as const } : {}),
        ...cardFunding(p.canonicalOrder),
      };
      const impact = p.decision === "REFUSE" ? null : await budgetImpact(userId, p.category, homeAmountMinor);
      return { summary, budgetImpact: impact };
    },
    logExpense: (input) => ingestCapture(userId, input),
    business: {
      async merchant() {
        const m = await merchantOfOwner(userId, db);
        return m ? { id: m.id, currency: m.currency, timezone: m.timezone, poCapMinor: m.poCapMinor } : null;
      },
      async forecast() {
        const m = await merchantOfOwner(userId, db);
        if (!m) throw Object.assign(new Error("No merchant for this account"), { code: "NO_MERCHANT" });
        return loadForecast(m, clock.now(), db);
      },
      async draftPurchaseOrder(input) {
        const m = await merchantOfOwner(userId, db);
        if (!m) return { ok: false, error: "NO_MERCHANT", message: "No merchant for this account" };
        return draftPurchaseOrder(m, { ...input, createdBy: "AGENT", now: clock.now() });
      },
    },
  };
}
