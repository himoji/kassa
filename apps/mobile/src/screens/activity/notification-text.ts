/**
 * Notifications whose `data` carries `{key, params}` (budget/messages.ts, payments/notify.ts on the server) are
 * rendered through i18n here; anything unknown or malformed falls back to the server's English title/body.
 * Money params are `{amountMinor, currency}`, formatted client-side.
 */
import type { NotificationDto } from "@kassa/shared";

import type { TFn } from "@/lib/i18n";

type Money = { amountMinor: number; currency: string };
type MoneyFn = (amountMinor: number, currency: string) => string;

const isMoney = (v: unknown): v is Money =>
  !!v &&
  typeof v === "object" &&
  Number.isSafeInteger((v as Money).amountMinor) &&
  typeof (v as Money).currency === "string";
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function notificationText(
  n: Pick<NotificationDto, "title" | "body" | "data">,
  t: TFn,
  money: MoneyFn
): { title: string; body: string } {
  const fallback = { title: n.title, body: n.body };
  const data = n.data as { key?: unknown; params?: Record<string, unknown> } | null;
  const p = data?.params;
  if (!data || !p || typeof data.key !== "string") return fallback;
  const amountWithHome = (amount: Money, home: unknown) =>
    isMoney(home) && home.currency !== amount.currency
      ? t("activity:notify.amountWithHome", {
          amount: money(amount.amountMinor, amount.currency),
          home: money(home.amountMinor, home.currency),
        })
      : money(amount.amountMinor, amount.currency);
  switch (data.key) {
    case "payment.sent":
    case "payment.failed": {
      if (!isStr(p.payee) || !isMoney(p.amount) || !isStr(p.rail)) return fallback;
      const vars = {
        payee: p.payee,
        amount: amountWithHome(p.amount, p.home),
        rail: t(`common:rail.${p.rail}`),
        mandate: p.mandate ? t("activity:notify.underMandate") : "",
      };
      const sent = data.key === "payment.sent";
      return {
        title: t(sent ? "activity:notify.sentTitle" : "activity:notify.failedTitle", vars),
        body: t(sent ? "activity:notify.sentBody" : "activity:notify.failedBody", vars),
      };
    }
    case "budget.each": {
      if (!isMoney(p.amount) || !isStr(p.merchant) || !isStr(p.category)) return fallback;
      const category = t(`common:category.${p.category}`);
      return {
        title: t("activity:notify.budgetTitle", { category }),
        body: t("activity:notify.budgetEachBody", {
          amount: amountWithHome(p.amount, p.home),
          merchant: p.merchant,
          category,
          used: Number(p.usedPct ?? 0),
          left: Number(p.leftPct ?? 0),
          days: Number(p.days ?? 0),
        }),
      };
    }
    case "fees.settled": {
      if (!isMoney(p.fee) || !isStr(p.merchant)) return fallback;
      return {
        title: t("activity:notify.feeTitle"),
        body: t("activity:notify.feeBody", {
          merchant: p.merchant,
          fee: money(p.fee.amountMinor, p.fee.currency),
          pct: (Number(p.markupBps ?? 0) / 100).toFixed(2),
        }),
      };
    }
    default:
      return fallback;
  }
}

/** Reason codes carried by a notification (`data.reasonCodes` or `data.params.reasonCodes`). */
export function notificationReasonCodes(n: Pick<NotificationDto, "data">): unknown[] {
  const d = n.data as { reasonCodes?: unknown; params?: { reasonCodes?: unknown } } | null;
  const raw = d?.reasonCodes ?? d?.params?.reasonCodes;
  return Array.isArray(raw) ? raw : [];
}
