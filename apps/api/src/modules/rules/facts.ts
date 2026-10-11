/*
 * Fact gathering for rules decisions (spec §10): caps usage, reserve, budget remaining, payment
 * history for risk features, local hour. Everything time-based uses the Clock passed in.
 */
import type { PayeeKind, Rail, Region } from "@kassa/shared";
import { and, eq, gte, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";

import type { DbOrTx } from "../../db/client.ts";
import { approvals, budgets, payments, proposals, transactions } from "../../db/schema.ts";
import { isoDate } from "../clock/index.ts";
import { toHome } from "../money/fx.ts";
import { normalizeName } from "../screening/normalize.ts";

/** Default budget category by payee kind when neither the caller nor an obligation gives one. */
export function defaultCategory(kind: PayeeKind): string {
  switch (kind) {
    case "LANDLORD":
      return "rent";
    case "UNIVERSITY":
      return "tuition";
    case "INSURER":
      return "insurance";
    case "MERCHANT":
      return "shopping";
    case "SUPPLIER":
      return "supplies";
    default:
      return "transfers";
  }
}

/** Rail when the proposal does not name one (spec §1 money modes, §11 rails). */
export function chooseRail(
  requested: Rail | undefined,
  moneyMode: "PAY_IN_PLACE" | "CAPPED_WALLET" | "HANDOFF",
  region: Region,
  payeeKind: PayeeKind,
): Rail {
  if (region === "CN" || moneyMode === "HANDOFF") return "HANDOFF";
  if (requested) return requested;
  if (payeeKind === "MERCHANT") return moneyMode === "PAY_IN_PLACE" ? "PAY_IN_PLACE" : "CARD_ISSUING";
  return "BANK_TRANSFER";
}

/** IANA zone used for the "unusual hour" feature. Spec has no per-user zone: EU hero lives in Budapest. */
export function zoneFor(region: Region): string {
  return region === "CN" ? "Asia/Shanghai" : "Europe/Budapest";
}

export function localHour(now: Date, zone: string): number {
  const h = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: zone }).format(now);
  return Number(h);
}

export function dayStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Home-currency amount of the user's live payments since `from` (rules' own view of caps usage). */
export async function paidHomeSince(db: DbOrTx, userId: string, from: Date): Promise<number> {
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${payments.homeAmountMinor}), 0)` })
    .from(payments)
    .where(and(eq(payments.userId, userId), notInArray(payments.status, ["FAILED", "CANCELED"]), gte(payments.createdAt, from)));
  return Number(rows[0]?.total ?? 0);
}

/**
 * (X3) Today's small-auto usage: live payments executed under a T1 approval WITHOUT a mandate (the signed small-auto
 * limit), count and home-currency total since `from`.
 */
export async function smallAutoUsedSince(db: DbOrTx, userId: string, from: Date): Promise<{ count: number; homeMinor: number }> {
  const rows = await db
    .select({ n: sql<string>`count(*)`, total: sql<string>`coalesce(sum(${payments.homeAmountMinor}), 0)` })
    .from(payments)
    .innerJoin(approvals, eq(approvals.id, payments.approvalId))
    .where(
      and(
        eq(payments.userId, userId),
        eq(approvals.tier, "T1"),
        isNull(approvals.mandateId),
        notInArray(payments.status, ["FAILED", "CANCELED"]),
        gte(payments.createdAt, from),
      ),
    );
  return { count: Number(rows[0]?.n ?? 0), homeMinor: Number(rows[0]?.total ?? 0) };
}

/** Remaining budget for a category in the period covering `now` (null = no budget). */
export async function categoryRemaining(db: DbOrTx, userId: string, category: string, now: Date): Promise<number | null> {
  const today = isoDate(now);
  const b = (
    await db
      .select()
      .from(budgets)
      .where(and(eq(budgets.userId, userId), eq(budgets.category, category), lte(budgets.periodStart, today), gte(budgets.periodEnd, today)))
  )[0];
  if (!b) return null;
  const start = new Date(`${b.periodStart}T00:00:00.000Z`);
  const end = new Date(`${b.periodEnd}T23:59:59.999Z`);
  const spent = await db
    .select({ total: sql<string>`coalesce(sum(${transactions.homeAmountMinor}), 0)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.category, category),
        isNull(transactions.mergedIntoId),
        gte(transactions.occurredAt, start),
        lte(transactions.occurredAt, end),
      ),
    );
  return b.limitHomeMinor - Number(spent[0]?.total ?? 0);
}

export type ItemLike = { key: string; unitPriceMinor: number; quantity: number };

export function itemsOf(items: unknown[] | undefined): ItemLike[] {
  if (!Array.isArray(items)) return [];
  const out: ItemLike[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const it = raw as Record<string, unknown>;
    const name = typeof it.sku === "string" && it.sku ? it.sku : typeof it.name === "string" ? normalizeName(it.name) : null;
    const unit = typeof it.unitPriceMinor === "number" ? it.unitPriceMinor : null;
    const qty = typeof it.quantity === "number" ? it.quantity : null;
    if (name && unit !== null && qty !== null) out.push({ key: name, unitPriceMinor: unit, quantity: qty });
  }
  return out;
}

/** Executed history to a payee: count + per-item price and quantity history. */
export async function payeeHistory(db: DbOrTx, userId: string, payeeId: string) {
  const rows = await db
    .select({ draft: proposals.draft })
    .from(proposals)
    .where(
      and(
        eq(proposals.userId, userId),
        sql`${proposals.draft}->>'payeeId' = ${payeeId}`,
        inArray(proposals.status, ["EXECUTED", "APPROVED"]),
      ),
    );
  const priceHistory: Record<string, number[]> = {};
  const qtyHistory: Record<string, number[]> = {};
  for (const r of rows) {
    for (const it of itemsOf(r.draft.items)) {
      (priceHistory[it.key] ??= []).push(it.unitPriceMinor);
      (qtyHistory[it.key] ??= []).push(it.quantity);
    }
  }
  return { count: rows.length, priceHistory, qtyHistory };
}

/** Capped-wallet balances per currency (same shape as rails/mockBank `WalletBalances`). */
export type WalletBalances = { currency: string; amountMinor: number }[];
type BalanceProvider = (userId: string) => Promise<WalletBalances | null>;

/*
 * The wallet reader is registered at startup (orders/wiring.ts → rails/mockBank.getWalletBalances), not
 * imported: agent → rules/facts must never reach rails/** at runtime (I1, transitive import graph).
 */
let walletReader: ((userId: string) => Promise<WalletBalances>) | null = null;

export function registerWalletReader(fn: ((userId: string) => Promise<WalletBalances>) | null): void {
  walletReader = fn;
}

const defaultBalanceProvider: BalanceProvider = async (userId) => {
  if (!walletReader) return null; // not wired (unit tests): balances unknown
  try {
    return await walletReader(userId);
  } catch {
    return null; // unknown balance: reserve rule cannot be evaluated → not breached (logged by caller)
  }
};

let balanceProvider: BalanceProvider = defaultBalanceProvider;

export function setBalanceProviderForTests(p: BalanceProvider | null): void {
  balanceProvider = p ?? defaultBalanceProvider;
}

export function walletBalances(userId: string): Promise<WalletBalances | null> {
  return balanceProvider(userId);
}

/**
 * Protected reserve (spec §10 step 5): true if paying would leave the total wallet balance (in the home
 * currency) below the reserve. null = balances unknown (mock bank unreachable) → cannot evaluate.
 */
export async function reserveBreached(
  userId: string,
  homeCurrency: string,
  reserveHomeMinor: number,
  amountHomeMinor: number,
  now: Date,
): Promise<boolean | null> {
  if (reserveHomeMinor <= 0) return false;
  const balances = await walletBalances(userId);
  if (!balances) return null;
  let total = 0;
  for (const b of balances) {
    try {
      total += (await toHome(b.amountMinor, b.currency, homeCurrency, now)).amountMinor;
    } catch {
      return null;
    }
  }
  return total - amountHomeMinor < reserveHomeMinor;
}
