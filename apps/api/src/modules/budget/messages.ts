import { formatMoney, type BudgetPace } from "@kassa/shared";

/*
 * Notification messages as structured `{key, params}` so the app localises them with i18next
 * (docs/DECISIONS.md "i18n via i18next"); the server also stores an English rendering in
 * notifications.title/body for logs and the web toast. Money params are {amountMinor, currency}
 * (formatted client-side with formatMoney); percentages are integers.
 */

export type MoneyParam = { amountMinor: number; currency: string };

export type BudgetMessage =
  | {
      key: "budget.each";
      params: { amount: MoneyParam; home?: MoneyParam; merchant: string; category: string; usedPct: number; leftPct: number; days: number; pace: BudgetPace; where?: string };
    }
  | {
      /** A spend in a category with no budget (EACH mode): the category's month so far and spending overall. */
      key: "budget.unbudgeted";
      params: {
        amount: MoneyParam;
        home?: MoneyParam;
        merchant: string;
        category: string;
        where?: string;
        /** This month in the category, this spend included. */
        spent: MoneyParam;
        count: number;
        /** Average month in the category, when there is history. */
        typical?: MoneyParam;
        /** This month across every category without a budget. */
        outside: MoneyParam;
        /** This month across all categories. */
        total: MoneyParam;
        /** total as a share of monthly income, when incomes are known. */
        incomeUsedPct?: number;
        days: number;
      };
    }
  | {
      key: "budget.threshold";
      params: { category: string; threshold: 50 | 80 | 100; usedPct: number; remaining: MoneyParam; days: number };
    }
  | {
      key: "budget.digest";
      params: {
        date: string;
        spentToday: MoneyParam;
        transactions: number;
        categories: Array<{ category: string; usedPct: number; leftPct: number; pace: BudgetPace }>;
        /** This month's spending in categories without a budget, when there is any. */
        outside?: MoneyParam;
      };
    }
  | {
      key: "fees.dcc";
      params: { merchant: string; overMidBps: number; charged: MoneyParam };
    }
  | {
      key: "fees.settled";
      params: { merchant: string; fee: MoneyParam; markupBps: number };
    };

const CATEGORY_EN: Record<string, string> = {
  groceries: "Groceries",
  eating_out: "Eating out",
  transport: "Transport",
  rent: "Rent",
  tuition: "Tuition",
  insurance: "Insurance",
  books: "Books",
  health: "Health",
  entertainment: "Entertainment",
  phone: "Phone",
  utilities: "Utilities",
  shopping: "Shopping",
  other: "Other",
};

/** English category label ("eating_out" → "Eating out"); unknown keys are shown as written. */
export const categoryEn = (c: string): string => CATEGORY_EN[c] ?? c;
const cat = categoryEn;
const money = (m: MoneyParam) => formatMoney(m.amountMinor, m.currency, "en");
const amountEn = (amount: MoneyParam, home?: MoneyParam) => `${money(amount)}${home && home.currency !== amount.currency ? ` (≈ ${money(home)})` : ""}`;
/** " in Budapest", unless the merchant name already says where ("Market Hall in Budapest"). */
const whereEn = (merchant: string, where?: string) => (where && !merchant.toLowerCase().includes(where.toLowerCase()) ? ` in ${where}` : "");
const paceEn = (p: BudgetPace) => (p === "ON_TRACK" ? "on track" : p === "AHEAD_OF_PACE" ? "ahead of pace" : "over budget");

/** English rendering. `budget.each` follows the spec §13 template, plus "(≈ home)" for a foreign spend (Y6). */
export function renderEn(m: BudgetMessage): { title: string; body: string } {
  switch (m.key) {
    case "budget.each": {
      const p = m.params;
      return {
        title: `${cat(p.category)} budget`,
        body: `${amountEn(p.amount, p.home)} at ${p.merchant}${whereEn(p.merchant, p.where)}. ${cat(p.category)}: ${p.usedPct}% used, ${p.leftPct}% left for ${p.days} days, ${paceEn(p.pace)}.`,
      };
    }
    case "budget.unbudgeted": {
      const p = m.params;
      const typical = p.typical ? `, usually ${money(p.typical)} a month` : "";
      const income = p.incomeUsedPct !== undefined ? ` (${p.incomeUsedPct}% of monthly income)` : "";
      return {
        title: `${cat(p.category)}: no budget`,
        body:
          `${amountEn(p.amount, p.home)} at ${p.merchant}${whereEn(p.merchant, p.where)}. ` +
          `${cat(p.category)} this month: ${money(p.spent)} in ${p.count} purchase${p.count === 1 ? "" : "s"}${typical}. ` +
          `Outside your budgets: ${money(p.outside)}. All spending: ${money(p.total)}${income}, ${p.days} day${p.days === 1 ? "" : "s"} left this month.`,
      };
    }
    case "budget.threshold": {
      const p = m.params;
      return {
        title: `${cat(p.category)}: ${p.threshold}% of budget used`,
        body: `${cat(p.category)}: ${p.usedPct}% used, ${money(p.remaining)} left for ${p.days} days.`,
      };
    }
    case "budget.digest": {
      const p = m.params;
      const lines = p.categories.map((c) => `${cat(c.category)} ${c.usedPct}% used (${paceEn(c.pace)})`).join("; ");
      return {
        title: `Daily summary ${p.date}`,
        body: `Today: ${money(p.spentToday)} in ${p.transactions} purchase${p.transactions === 1 ? "" : "s"}.${lines ? ` ${lines}.` : ""}${p.outside && p.outside.amountMinor > 0 ? ` Outside your budgets this month: ${money(p.outside)}.` : ""}`,
      };
    }
    case "fees.dcc": {
      const p = m.params;
      return {
        title: "Charged in your home currency abroad",
        body: `${p.merchant} charged ${money(p.charged)}, ${(p.overMidBps / 100).toFixed(1)}% over the mid-market rate. Choose to pay in the local currency next time.`,
      };
    }
    case "fees.settled": {
      const p = m.params;
      return {
        title: "Card fee found",
        body: `${p.merchant}: ${money(p.fee)} in conversion fees (${(p.markupBps / 100).toFixed(2)}% over mid).`,
      };
    }
  }
}

/** Which thresholds (50/80/100 %) were crossed by moving from usedBefore to usedAfter (percent). */
export function crossedThresholds(usedBeforePct: number, usedAfterPct: number): Array<50 | 80 | 100> {
  return ([50, 80, 100] as const).filter((t) => usedBeforePct < t && usedAfterPct >= t);
}
