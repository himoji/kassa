import {
  BalancesResponse,
  CardDto,
  CardsResponse,
  CreateCardRequest,
  ObligationsResponse,
  SetTransactionCategoryRequest,
  TransactionsResponse,
} from "@kassa/shared";
import type { ObligationDto } from "@kassa/shared";
import { and, asc, desc, eq, isNull, lt, or } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { cards, mandates, obligations, payees, transactions, users } from "../../db/schema.ts";
import { ownedNotFound } from "../../http/audit.ts";
import { toTransactionDto } from "./transaction-dto.ts";
import { HttpProblem, notFound } from "../../http/problem.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { clock, DAY_MS, isoDate } from "../clock/index.ts";
import { setTransactionCategory } from "../capture/index.ts";
import { toHome, type HomeAmount } from "./fx.ts";
import { walletBalances } from "../rules/facts.ts";
import { chooseFunding } from "../rules/funding.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_MANDATE_STATUSES = new Set<string>(["ACTIVE", "PENDING_EFFECTIVE"]);

const TransactionsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const CategoryParams = z.object({ id: z.string().uuid() });

/** Home-currency conversion that never throws: null when no rate can be produced. */
async function homeOf(amountMinor: number, currency: string, homeCurrency: string, now: Date): Promise<HomeAmount | null> {
  try {
    return await toHome(amountMinor, currency, homeCurrency, now);
  } catch {
    return null;
  }
}

/** Parses `${occurredAt.toISOString()}|${id}`; anything else is a bad cursor. */
function parseCursor(raw: string): { occurredAt: Date; id: string } {
  const bar = raw.indexOf("|");
  const tsRaw = bar > 0 ? raw.slice(0, bar) : "";
  const idRaw = bar > 0 ? raw.slice(bar + 1) : "";
  const occurredAt = new Date(tsRaw);
  if (!tsRaw || Number.isNaN(occurredAt.getTime()) || !UUID_RE.test(idRaw)) {
    throw new HttpProblem(400, "BAD_CURSOR", "Invalid cursor");
  }
  return { occurredAt, id: idRaw };
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  app.get("/balances", { schema: { response: { 200: BalancesResponse } } }, async (req) => {
    const userId = userIdOf(req);
    const db = getDb();
    const [user] = await db.select({ homeCurrency: users.homeCurrency }).from(users).where(eq(users.id, userId));
    if (!user) throw notFound("user");
    const homeCurrency = user.homeCurrency;
    const now = clock.now();

    const balances = (await walletBalances(userId)) ?? [];
    let rateDate: string | null = null;
    const rows: { currency: string; amountMinor: number; homeAmountMinor: number }[] = [];
    let homeTotalMinor = 0;

    for (const b of balances) {
      const home = await homeOf(b.amountMinor, b.currency, homeCurrency, now);
      const homeAmountMinor = home?.amountMinor ?? 0;
      if (home && rateDate === null && b.currency !== homeCurrency) rateDate = home.rateDate;
      homeTotalMinor += homeAmountMinor;
      rows.push({ currency: b.currency, amountMinor: b.amountMinor, homeAmountMinor });
    }

    return {
      homeCurrency,
      homeTotalMinor,
      balances: rows,
      rateDate,
      simulated: true,
    };
  });

  app.get("/obligations", { schema: { response: { 200: ObligationsResponse } } }, async (req) => {
    const userId = userIdOf(req);
    const db = getDb();
    const [user] = await db.select({ homeCurrency: users.homeCurrency }).from(users).where(eq(users.id, userId));
    if (!user) throw notFound("user");
    const homeCurrency = user.homeCurrency;
    const now = clock.now();

    const rows = await db
      .select({
        id: obligations.id,
        payeeId: obligations.payeeId,
        payeeName: payees.name,
        payeeStatus: payees.status,
        payeeKind: payees.kind,
        payeeAccountHash: payees.accountHash,
        amountMinor: obligations.amountMinor,
        currency: obligations.currency,
        dueDate: obligations.dueDate,
        recurrence: obligations.recurrence,
        reference: obligations.reference,
        category: obligations.category,
      })
      .from(obligations)
      .innerJoin(payees, eq(payees.id, obligations.payeeId))
      .where(eq(obligations.userId, userId))
      .orderBy(asc(obligations.dueDate));

    // Loaded once; the per-obligation match is done in JS.
    const userMandates = await db
      .select()
      .from(mandates)
      .where(eq(mandates.userId, userId))
      .orderBy(asc(mandates.createdAt));
    const activeMandates = userMandates.filter((m) => ACTIVE_MANDATE_STATUSES.has(m.status));

    const obligationDtos: ObligationDto[] = [];
    // Coverage the way the rules check it before a bank transfer (rules/funding.ts): can one wallet balance pay this
    // bill, with fees, in time? Checked for bills due in the next 45 days; "Covered" on Home then means "Pay" works.
    // The route that check picks (cheapest by home-currency cost, spec §12 optimizer) is the bill's best route.
    // Unknown balances or a failed check are UNKNOWN, never COVERED. The wallet is read once for the whole list;
    // FX quotes come from the rates service's daily cache.
    const horizon = isoDate(new Date(now.getTime() + 45 * DAY_MS));
    let balances: Awaited<ReturnType<typeof walletBalances>> = null;
    let balancesRead = false;
    const planOf = async (o: (typeof rows)[number]): Promise<Pick<ObligationDto, "coverage" | "bestRoute">> => {
      if (o.payeeKind === "MERCHANT" || o.payeeAccountHash === null || o.dueDate > horizon) return { coverage: "COVERED", bestRoute: null };
      try {
        if (!balancesRead) {
          balancesRead = true;
          balances = await walletBalances(userId);
        }
        if (!balances) return { coverage: "UNKNOWN", bestRoute: null };
        const f = await chooseFunding({ userId, homeCurrency, amountMinor: o.amountMinor, currency: o.currency, now, dueDate: o.dueDate, balances });
        if (f.status === "NONE") return { coverage: "SHORTFALL", bestRoute: null };
        if (f.status === "UNKNOWN") return { coverage: "UNKNOWN", bestRoute: null };
        const { amountInFundingMinor: _a, totalDebitFundingMinor: _t, ...route } = f.route;
        const direct = route.fundingCurrency === o.currency ? { noConversion: true, balanceCovers: true } : {};
        return { coverage: "COVERED", bestRoute: { ...route, ...direct } };
      } catch (err) {
        req.log.warn({ err, obligationId: o.id }, "obligation coverage check failed");
        return { coverage: "UNKNOWN", bestRoute: null };
      }
    };

    for (const o of rows) {
      const home = await homeOf(o.amountMinor, o.currency, homeCurrency, now);
      const mandate = activeMandates.find((m) => m.payeeIds.includes(o.payeeId) && m.categories.includes(o.category));
      obligationDtos.push({
        id: o.id,
        payeeId: o.payeeId,
        payeeName: o.payeeName,
        payeeStatus: o.payeeStatus,
        payeeAccountMissing: o.payeeAccountHash === null,
        amountMinor: o.amountMinor,
        currency: o.currency,
        homeAmountMinor: home?.amountMinor ?? 0,
        dueDate: o.dueDate,
        recurrence: o.recurrence,
        reference: o.reference,
        category: o.category,
        ...(await planOf(o)),
        mandateId: mandate?.id ?? null,
      });
    }

    return { obligations: obligationDtos };
  });

  app.get("/cards", { schema: { response: { 200: CardsResponse } } }, async (req) => {
    const userId = userIdOf(req);
    const rows = await getDb()
      .select({
        id: cards.id,
        label: cards.label,
        last4: cards.last4,
        billingCurrency: cards.billingCurrency,
        kind: cards.kind,
      })
      .from(cards)
      .where(eq(cards.userId, userId));
    return { cards: rows };
  });

  // Cards added by hand (Cards tab). Adding or removing a card loosens nothing: cards only label spending.
  app.post("/cards", { schema: { body: CreateCardRequest, response: { 201: CardDto } } }, async (req, reply) => {
    const userId = userIdOf(req);
    const db = getDb();
    const dup = await db.select({ id: cards.id }).from(cards).where(and(eq(cards.userId, userId), eq(cards.last4, req.body.last4), eq(cards.label, req.body.label)));
    if (dup.length > 0) throw new HttpProblem(409, "CARD_EXISTS", "You already have this card");
    const row = (
      await db
        .insert(cards)
        .values({ userId, ...req.body })
        .returning({ id: cards.id, label: cards.label, last4: cards.last4, billingCurrency: cards.billingCurrency, kind: cards.kind })
    )[0]!;
    return reply.status(201).send(row);
  });

  app.delete("/cards/:id", { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    const userId = userIdOf(req);
    const removed = await getDb().transaction(async (tx) => {
      const own = await tx.select({ id: cards.id }).from(cards).where(and(eq(cards.id, req.params.id), eq(cards.userId, userId)));
      if (own.length === 0) return false;
      // Past spending keeps its record, without the card.
      await tx.update(transactions).set({ cardId: null }).where(eq(transactions.cardId, req.params.id));
      await tx.delete(cards).where(eq(cards.id, req.params.id));
      return true;
    });
    if (!removed) {
      throw await ownedNotFound(userId, "card", req.params.id, async () => (await getDb().select({ id: cards.id }).from(cards).where(eq(cards.id, req.params.id))).length > 0);
    }
    return reply.status(204).send();
  });

  app.get(
    "/transactions",
    { schema: { querystring: TransactionsQuery, response: { 200: TransactionsResponse } } },
    async (req) => {
      const userId = userIdOf(req);
      const { cursor, limit } = req.query;

      const conditions = [eq(transactions.userId, userId), isNull(transactions.mergedIntoId)];
      if (cursor !== undefined) {
        const c = parseCursor(cursor);
        conditions.push(
          or(
            lt(transactions.occurredAt, c.occurredAt),
            and(eq(transactions.occurredAt, c.occurredAt), lt(transactions.id, c.id)),
          )!,
        );
      }

      const rows = await getDb()
        .select()
        .from(transactions)
        .where(and(...conditions))
        .orderBy(desc(transactions.occurredAt), desc(transactions.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const nextCursor = hasMore && last ? `${last.occurredAt.toISOString()}|${last.id}` : null;

      return { items: page.map(toTransactionDto), nextCursor };
    },
  );

  app.post(
    "/transactions/:id/category",
    { schema: { params: CategoryParams, body: SetTransactionCategoryRequest } },
    async (req, reply) => {
      const userId = userIdOf(req);
      const ok = await setTransactionCategory(userId, req.params.id, req.body.category);
      if (!ok) {
        throw await ownedNotFound(userId, "transaction", req.params.id, async () => (await getDb().select({ id: transactions.id }).from(transactions).where(eq(transactions.id, req.params.id))).length > 0);
      }
      return reply.status(204).send();
    },
  );
};

export default routes;
