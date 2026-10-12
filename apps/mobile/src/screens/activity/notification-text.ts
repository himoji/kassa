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
    case "business.shortage": {
      // (Business M4) business/scheduler.ts: forecast shortage → drafted purchase order.
      const items = Array.isArray(p.items) ? (p.items as Record<string, unknown>[]) : [];
      const named = items.filter(
        (i) => isStr(i.name) && Number.isSafeInteger(i.shortage) && isStr(i.unit)
      );
      if (!isStr(p.supplier) || !isMoney(p.total) || named.length === 0) return fallback;
      return {
        title: t("business:notifyShortageTitle"),
        body: t("business:notifyShortageBody", {
          items: named
            .map(
              (i) =>
                `${String(i.name)} (${t(`business:unit.${String(i.unit)}`, { qty: Number(i.shortage), defaultValue: `${Number(i.shortage)} ${String(i.unit)}` })})`
            )
            .join(", "),
          supplier: p.supplier,
          total: money(p.total.amountMinor, p.total.currency),
        }),
      };
    }
    case "business.poDrafted": {
      if (!isStr(p.supplier) || !isMoney(p.total)) return fallback;
      return {
        title: t("business:notifyPoDraftedTitle"),
        body: t("business:notifyPoDraftedBody", {
          supplier: p.supplier,
          total: money(p.total.amountMinor, p.total.currency),
        }),
      };
    }
    case "business.poDelivered": {
      if (!isStr(p.supplier)) return fallback;
      return {
        title: t("business:notifyPoDeliveredTitle"),
        body: t("business:notifyPoDeliveredBody", { supplier: p.supplier }),
      };
    }
    case "business.invoiceRefused": {
      // business/invoices.ts three-way match: the invoice disagrees with the signed PO.
      if (!isStr(p.supplier)) return fallback;
      const above = p.reason === "INVOICE_ABOVE_PO";
      if (!above && p.reason !== "INVOICE_ACCOUNT_MISMATCH") return fallback;
      return {
        title: t(above ? "business:notifyInvoiceAboveTitle" : "business:notifyInvoiceAccountTitle"),
        body: t(above ? "business:notifyInvoiceAboveBody" : "business:notifyInvoiceAccountBody", {
          supplier: p.supplier,
        }),
      };
    }
    case "shop.orderStatus": {
      // commerce/service.ts: a shop / till order moved forward (or ended).
      if (!isStr(p.merchant) || !isStr(p.status)) return fallback;
      const status = t(`shop:status.${p.status}`, { defaultValue: "" });
      if (!status) return fallback;
      const ended = p.status === "DECLINED" || p.status === "FAILED";
      return {
        title: t("shop:notifyStatusTitle", { merchant: p.merchant, status }),
        body: ended
          ? t("shop:notifyEndedBody", { code: isStr(p.reasonCode) ? p.reasonCode : "unknown" })
          : t(p.channel === "TILL" ? "shop:notifyTillBody" : "shop:notifyShopBody"),
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
