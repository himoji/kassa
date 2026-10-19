/*
 * (X9, p1 B3/B5) Payment outcome notifications: PAYMENT_SENT / PAYMENT_FAILED for every rail (bank transfer, card,
 * handoff, pay in place). Like budget/messages.ts, `data` carries `{key, params}` for i18next (money params are
 * {amountMinor, currency}, formatted client-side) and title/body are the English rendering for logs and toasts.
 * Fields: payee display name (the signed order's payeeName), amount in the original and the home currency, rail,
 * and the mandate for T1 mandate payments.
 */
import { formatMoney, orderConversion, type CanonicalOrder, type OrderRail as Rail, type ReasonCode } from "@kassa/shared";
import { eq } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { approvals, mandates, payments, proposals } from "../../db/schema.ts";
import { notify } from "../notifications/service.ts";

type MoneyParam = { amountMinor: number; currency: string };

export type PaymentMessage = {
  /** (2026-10-18) conversion.* for a CONVERT order (the app shows the English text for keys it does not know). */
  key: "payment.sent" | "payment.failed" | "conversion.done" | "conversion.failed";
  params: {
    payee: string;
    amount: MoneyParam;
    home: MoneyParam;
    rail: Rail;
    mandate: { id: string; categories: string[] } | null;
    reasonCodes: ReasonCode[];
  };
};

const RAIL_EN: Record<Rail, string> = {
  BANK_TRANSFER: "bank transfer",
  CARD_ISSUING: "one-time card",
  HANDOFF: "QR wallet (handoff)",
  PAY_IN_PLACE: "pay in place",
  CONVERT: "conversion between your balances",
};

function money(m: MoneyParam): string {
  try {
    return formatMoney(m.amountMinor, m.currency, "en");
  } catch {
    return `${m.amountMinor} ${m.currency} (minor units)`;
  }
}

export function renderPaymentEn(m: PaymentMessage): { title: string; body: string } {
  const p = m.params;
  const amount = p.home.currency !== p.amount.currency ? `${money(p.amount)} (≈ ${money(p.home)})` : money(p.amount);
  if (m.key === "conversion.done") return { title: `Converted into ${money(p.amount)}`, body: `${money(p.amount)} added to your ${p.amount.currency} balance by a conversion between your own balances (simulated).` };
  if (m.key === "conversion.failed") {
    return { title: `Conversion into ${money(p.amount)} not done`, body: `The conversion into ${money(p.amount)} was not done: ${p.reasonCodes.join(", ") || "failed"}. Your balances are unchanged.` };
  }
  const mandate = p.mandate ? ` under your signed mandate ${p.mandate.id.slice(0, 8)} for ${p.mandate.categories.join(", ")}` : "";
  if (m.key === "payment.sent") {
    return { title: `Payment sent to ${p.payee}`, body: `${amount} to ${p.payee} by ${RAIL_EN[p.rail]}${mandate} (simulated).` };
  }
  return {
    title: `Payment to ${p.payee} not sent`,
    body: `${amount} to ${p.payee} by ${RAIL_EN[p.rail]}${mandate} was not sent: ${p.reasonCodes.join(", ") || "failed"}. No money left your account.`,
  };
}

/** Notify the outcome of a payment. Best effort: a notification failure never changes the payment. */
export async function notifyPaymentOutcome(paymentId: string, status: "SENT" | "FAILED" | "CANCELED", reasonCodes: ReasonCode[]): Promise<void> {
  try {
    const db = getDb();
    const pay = (await db.select().from(payments).where(eq(payments.id, paymentId)))[0];
    if (!pay) return;
    const order = (await db.select({ o: proposals.canonicalOrder }).from(proposals).where(eq(proposals.id, pay.proposalId)))[0]?.o;
    const a = (await db.select({ mandateId: approvals.mandateId, tier: approvals.tier }).from(approvals).where(eq(approvals.id, pay.approvalId)))[0];
    let mandate: PaymentMessage["params"]["mandate"] = null;
    if (a?.tier === "T1" && a.mandateId) {
      const m = (await db.select({ id: mandates.id, categories: mandates.categories }).from(mandates).where(eq(mandates.id, a.mandateId)))[0];
      if (m) mandate = { id: m.id, categories: m.categories };
    }
    let conversion = false;
    try {
      conversion = order ? orderConversion(order as CanonicalOrder) !== null : false;
    } catch {
      conversion = false;
    }
    const msg: PaymentMessage = {
      key: conversion ? (status === "SENT" ? "conversion.done" : "conversion.failed") : status === "SENT" ? "payment.sent" : "payment.failed",
      params: {
        payee: order?.payeeName ?? "payee",
        amount: { amountMinor: pay.amountMinor, currency: pay.currency },
        home: { amountMinor: pay.homeAmountMinor, currency: pay.homeCurrency },
        rail: pay.rail,
        mandate,
        reasonCodes,
      },
    };
    const en = renderPaymentEn(msg);
    await notify(pay.userId, {
      kind: status === "SENT" ? "PAYMENT_SENT" : "PAYMENT_FAILED",
      title: en.title,
      body: en.body,
      data: { key: msg.key, params: msg.params, paymentId: pay.id, proposalId: pay.proposalId, status },
    });
  } catch (err) {
    console.warn(`[payments] outcome notification for ${paymentId} failed: ${(err as Error).message}`);
  }
}
