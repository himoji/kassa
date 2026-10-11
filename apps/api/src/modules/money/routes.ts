import {
  BalancesResponse,
  CardsResponse,
  ObligationsResponse,
  SetTransactionCategoryRequest,
  TransactionsResponse,
} from "@kassa/shared";
import type { ObligationDto, TransactionDto } from "@kassa/shared";
import { and, asc, desc, eq, isNull, lt, or } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { cards, mandates, obligations, payees, transactions, users } from "../../db/schema.ts";
import { HttpProblem, notFound } from "../../http/problem.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { clock } from "../clock/index.ts";
import { setTransactionCategory } from "../capture/index.ts";
import { toHome, type HomeAmount } from "./fx.ts";
import { walletBalances } from "../rules/facts.ts";

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

type TransactionRow = typeof transactions.$inferSelect;

function toTransactionDto(row: TransactionRow): TransactionDto {
  return {
    id: row.id,
    source: row.source,
    occurredAt: row.occurredAt.toISOString(),
    merchantRaw: row.merchantRaw,
    merchantNorm: row.merchantNorm,
    mcc: row.mcc,
    amountMinor: row.amountMinor,
    currency: row.currency,
    cardId: row.cardId,
    homeAmountMinor: row.homeAmountMinor,
    rateUsed: row.rateUsed,
    rateDate: row.rateDate,
    settledAmountMinor: row.settledAmountMinor,
    settledCurrency: row.settledCurrency,
    feeHomeMinor: row.feeHomeMinor,
    category: row.category,
    mergedIntoId: row.mergedIntoId,
    status: row.status,
  };
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
    for (const o of rows) {
      const home = await homeOf(o.amountMinor, o.currency, homeCurrency, now);
      const mandate = activeMandates.find((m) => m.payeeIds.includes(o.payeeId) && m.categories.includes(o.category));
      obligationDtos.push({
        id: o.id,
        payeeId: o.payeeId,
        payeeName: o.payeeName,
        payeeStatus: o.payeeStatus,
        amountMinor: o.amountMinor,
        currency: o.currency,
        homeAmountMinor: home?.amountMinor ?? 0,
        dueDate: o.dueDate,
        recurrence: o.recurrence,
        reference: o.reference,
        category: o.category,
        bestRoute: null,
        coverage: "COVERED",
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
      if (!ok) throw notFound("transaction");
      return reply.status(204).send();
    },
  );
};

export default routes;
