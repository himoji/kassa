/*
 * Account history and "today" for seeded demo accounts (judge build copies and the seeded hero).
 *
 * A seeded persona stands for an account in use for months, but Kassa's own tables only hold what happened since the
 * seed. So the seed carries a short, SIMULATED history of the months before (fixtures/seed-data.ts `history`): its
 * bills paid on time and its monthly money in. It is recorded ONCE, at the time it is seeded, as one ledger entry
 * ACCOUNT_HISTORY_IMPORTED ({ simulated: true, source: "seed" }) — never as back-dated ledger entries, payments or
 * settlements, which would falsify the hash chain's time order and the caps / mandate usage. The entry also names the
 * day the account was opened (`openedOn`, before the history), which the credit record uses instead of the database
 * row's creation day. The same rows feed the statement analysis the agent reads (profiles.money_history,
 * get_money_history), built by the dataport's own history code at the example rates.
 *
 * Judge copies (auth/dev.ts judgeLoginUser) also get, after their seeded mandates are in effect:
 *  - their mandate-covered monthly bills moved into the due window (scheduler/window.ts), so the reviewer sees the
 *    scheduler pay the rent under the mandate without a prompt (on the next tick, or at once with POST
 *    /demo/run-due-payments); the shared clock is never moved;
 *  - this month's money from home received in their own wallet (the mock bank's remittance, like the Demo screen's
 *    "Parents send money"), so the tuition can be paid after a conversion.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { ImportHistory } from "@kassa/shared";

import { getDb } from "../../db/client.ts";
import { ledgerEntries, mandates, obligations, payees, profiles, users } from "../../db/schema.ts";
import { addMs, clock, DAY_MS, isoDate } from "../clock/index.ts";
import { buildHistory } from "../dataport/history.ts";
import type { StatementRow } from "../dataport/statement.ts";
import { convertMinor } from "../fx/rational.ts";
import { RatesService } from "../fx/rates.ts";
import { ledger } from "../ledger/index.ts";
import { mockWorld } from "../rails/http.ts";
import { addMonths, DUE_WINDOW_DAYS } from "../scheduler/window.ts";
import { settlementFor } from "../obligations/settlements.ts";
import { ACCOUNT_HISTORY_TYPE, accountHistoryOf, type AccountHistory } from "./accountHistory.ts";
import { ensureWalletProfile } from "../wallet/service.ts";

/** Seed data: the months of history before the seed day (fixtures/seed-data.ts). */
export type SeedHistory = {
  months: number;
  /** Bills paid on time in those months: the obligation, its cadence in months, and how many days early it was paid. */
  bills: readonly { obligationId: string; everyMonths: number; paidDaysBefore: number }[];
};

/** The dates of a cadence before `today`, stepping back from `from`, not earlier than `cutoff`. */
function datesBack(from: string, everyMonths: number, cutoff: string, today: string): string[] {
  const out: string[] = [];
  for (let k = 1; k <= 120; k++) {
    const d = addMonths(from, -everyMonths * k);
    if (d < cutoff) break;
    if (d < today) out.push(d);
  }
  return out.reverse();
}

/**
 * Record the seeded history of `userId` as of `anchor` (the copy's sign-in, or the seed day for the seeded hero), and
 * fill the money history the agent reads when the user has none yet. Idempotent: a user with a history keeps it.
 */
export async function seedAccountHistory(userId: string, spec: SeedHistory, anchor: Date): Promise<AccountHistory | null> {
  if (await accountHistoryOf(userId)) return null;
  const db = getDb();
  const today = isoDate(anchor);
  const cutoff = addMonths(today, -spec.months);
  const openedOn = `${addMonths(today, -(spec.months + 1)).slice(0, 7)}-01`;
  const ids = spec.bills.map((b) => b.obligationId);
  const obs = ids.length
    ? await db
        .select({ o: obligations, payeeName: payees.name })
        .from(obligations)
        .innerJoin(payees, eq(payees.id, obligations.payeeId))
        .where(and(eq(obligations.userId, userId), inArray(obligations.id, ids)))
    : [];
  const bills: AccountHistory["bills"] = [];
  const rows: StatementRow[] = [];
  const row = (occurredAt: string, description: string, amountMinor: number, currency: string, kind: StatementRow["kind"], category: string | null): StatementRow => ({
    occurredAt: `${occurredAt}T10:00:00.000Z`,
    description,
    operation: null,
    amountMinor,
    currency,
    settled: null,
    category,
    cardLast4: null,
    mcc: null,
    kind,
    via: "records",
    file: 0,
  });
  for (const b of spec.bills) {
    const hit = obs.find((x) => x.o.id === b.obligationId);
    if (!hit) continue;
    const { o } = hit;
    for (const period of datesBack(o.dueDate, b.everyMonths, cutoff, today)) {
      const paidOn = isoDate(addMs(new Date(`${period}T12:00:00.000Z`), -b.paidDaysBefore * DAY_MS));
      bills.push({ obligationId: o.id, category: o.category, period, paidOn, amountMinor: o.amountMinor, currency: o.currency });
      rows.push(row(paidOn, hit.payeeName, -o.amountMinor, o.currency, "TRANSFER_OUT", o.category));
    }
  }
  const profile = (await db.select({ incomes: profiles.incomes, moneyHistory: profiles.moneyHistory }).from(profiles).where(eq(profiles.userId, userId)))[0];
  const incomes: AccountHistory["incomes"] = [];
  for (const i of profile?.incomes ?? []) {
    if (i.cadence !== "MONTHLY") continue;
    for (const on of datesBack(i.nextDate, 1, cutoff, today)) {
      incomes.push({ on, amountMinor: i.amountMinor, currency: i.currency });
      rows.push(row(on, `Transfer from ${i.source}`, i.amountMinor, i.currency, "INCOME", null));
    }
  }
  bills.sort((a, b) => a.period.localeCompare(b.period));
  incomes.sort((a, b) => a.on.localeCompare(b.on));
  const history: AccountHistory = { userId, simulated: true, source: "seed", openedOn, bills, incomes };
  await ledger.append(ACCOUNT_HISTORY_TYPE, history);

  // The statement analysis the agent reads (get_money_history), unless the user imported statements of their own.
  if (profile && !profile.moneyHistory && rows.length) {
    const u = (await db.select({ homeCurrency: users.homeCurrency }).from(users).where(eq(users.id, userId)))[0];
    if (u) {
      const moneyHistory = await simulatedMoneyHistory(rows, u.homeCurrency, cutoff, today);
      await db.update(profiles).set({ moneyHistory }).where(eq(profiles.userId, userId));
    }
  }
  return history;
}

/** The dataport's history analysis over the seeded rows, at the example rates (no network at sign-in; simulated data). */
async function simulatedMoneyHistory(rows: StatementRow[], homeCurrency: string, from: string, to: string): Promise<ImportHistory> {
  const fx = new RatesService({ offline: true });
  const { history } = await buildHistory(rows, {
    homeCurrency,
    today: to,
    categoryOf: (r) => r.category ?? "other",
    statements: [{ file: 0, name: "Account history (simulated)", bank: null, from, to }],
    toHome: async (amountMinor, currency, day) => {
      if (currency === homeCurrency) return { amountMinor, exact: true };
      try {
        const q = await fx.getRate(currency, homeCurrency, day);
        return { amountMinor: convertMinor(amountMinor, currency, homeCurrency, q.rate), exact: false };
      } catch {
        return { amountMinor: 0, exact: false };
      }
    },
  });
  return history;
}

/**
 * Judge copy: each monthly bill covered by one of the user's ACTIVE mandates and not yet claimed is moved to fall due
 * in DUE_WINDOW_DAYS − 1 days, inside the scheduler's window. Ledgered (OBLIGATION_RESCHEDULED, reason
 * JUDGE_COPY_DUE_NOW). Only this user's own bills move; the clock does not.
 */
export async function bringMandateBillsDue(userId: string, now: Date = clock.now()): Promise<number> {
  const db = getDb();
  const active = await db
    .select()
    .from(mandates)
    .where(and(eq(mandates.userId, userId), eq(mandates.status, "ACTIVE"), isNull(mandates.revokedAt)));
  if (active.length === 0) return 0;
  const due = isoDate(addMs(now, (DUE_WINDOW_DAYS - 1) * DAY_MS));
  const bills = await db.select().from(obligations).where(and(eq(obligations.userId, userId), eq(obligations.recurrence, "MONTHLY")));
  let moved = 0;
  for (const o of bills) {
    if (!active.some((m) => m.payeeIds.includes(o.payeeId) && m.categories.includes(o.category) && m.currency === o.currency)) continue;
    if (o.dueDate <= due) continue;
    if (await settlementFor(db, o.id, o.dueDate)) continue;
    await db.update(obligations).set({ dueDate: due }).where(eq(obligations.id, o.id));
    await ledger.append("OBLIGATION_RESCHEDULED", { userId, obligationId: o.id, from: o.dueDate, to: due, reason: "JUDGE_COPY_DUE_NOW" });
    moved++;
  }
  return moved;
}

/**
 * Money from home into the user's OWN wallet (mock bank remittance; the bank's webhook then records TRIGGER_REMITTANCE
 * and notifies). About EUR 2,000 in the home currency (Dana's parents send KZT 1,000,000, the demo story).
 */
export const MONEY_FROM_HOME_MINOR: Readonly<Record<string, number>> = {
  KZT: 100_000_000,
  CNY: 1_500_000,
  EUR: 200_000,
  USD: 200_000,
  HUF: 80_000_000,
};
/** "Parents send money" presses per user per (Clock) day; the copy's own seeded transfer does not count. */
export const MONEY_FROM_HOME_DAILY_MAX = 3;

export async function moneyFromHomeToday(userId: string, now: Date = clock.now()): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<string>`count(*)` })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.type, "DEMO_TRIGGER"),
        sql`${ledgerEntries.payload}->>'scenario' = 'money-from-home'`,
        sql`${ledgerEntries.payload}->>'userId' = ${userId}`,
        sql`${ledgerEntries.payload}->>'via' is null`,
        sql`${ledgerEntries.ts} >= ${`${isoDate(now)}T00:00:00.000Z`}`,
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

export async function sendMoneyFromHome(userId: string, via?: "judge-copy"): Promise<{ currency: string; amountMinor: number; balanceAfterMinor: number }> {
  const u = (await getDb().select({ homeCurrency: users.homeCurrency }).from(users).where(eq(users.id, userId)))[0];
  if (!u) throw new Error("user not found");
  const currency = MONEY_FROM_HOME_MINOR[u.homeCurrency] ? u.homeCurrency : "EUR";
  const amountMinor = MONEY_FROM_HOME_MINOR[currency]!;
  // Opens the wallet if the mock bank has none for this user yet (idempotent), and names the user's own profile.
  const profileId = await ensureWalletProfile(userId);
  const r = await mockWorld<{ event?: { balanceAfterMinor?: unknown } }>("POST", "/remittance/incoming", { profileId, amountMinor, currency, sender: "Parents (simulated)" });
  const balanceAfterMinor = Number(r.event?.balanceAfterMinor);
  await ledger.append("DEMO_TRIGGER", { scenario: "money-from-home", userId, self: true, currency, amountMinor, ...(via ? { via } : {}) });
  return { currency, amountMinor, balanceAfterMinor: Number.isSafeInteger(balanceAfterMinor) ? balanceAfterMinor : 0 };
}
