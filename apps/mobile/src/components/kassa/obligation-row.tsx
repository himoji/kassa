import type { ObligationDto } from "@kassa/shared";
import { router } from "expo-router";
import { Pressable, View } from "react-native";

import { Box, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";
import type { StatusTone } from "@/theme/status";

import { StatusChip } from "./status-chip";

/** Covered, payable after converting between balances, short, or unknown (never shown as covered). */
const COVERAGE_TONE: Record<ObligationDto["coverage"], StatusTone> = {
  COVERED: "positive",
  CONVERTIBLE: "warning",
  SHORTFALL: "critical",
  UNKNOWN: "neutral",
};

/** (2026-10-19) Where the bill's current period stands; DUE shows coverage instead. */
const PERIOD_TONE: Record<Exclude<ObligationDto["status"], "DUE">, StatusTone> = {
  PAID: "positive",
  IN_FLIGHT: "info",
  AWAITING_APPROVAL: "warning",
};

/**
 * One upcoming bill: amount, due date, best route, coverage and payee status (spec §16 Home). (2026-10-19) A bill whose
 * period is paid or on its way says so ("Paid 19 Oct", "Payment pending") instead of its coverage, with the next due
 * date of a recurring bill, and opens nothing (there is nothing to pay or convert for it).
 */
export function ObligationRow({
  obligation,
  homeCurrency,
}: {
  obligation: ObligationDto;
  homeCurrency: string;
}) {
  const t = useKassaT();
  const f = useFormat();
  const o = obligation;
  const settled = o.status === "PAID" || o.status === "IN_FLIGHT";
  const steps = !settled && o.coverage === "CONVERTIBLE" ? (o.conversions ?? []) : [];
  const periodLabel =
    o.status === "PAID"
      ? t("bills:periodStatus.PAID", { date: f.date(o.paidAt ?? o.dueDate) })
      : o.status === "IN_FLIGHT" || o.status === "AWAITING_APPROVAL"
        ? t(`bills:periodStatus.${o.status}`)
        : null;
  const body = (
    <>
      <Box row justify="between" gap={3}>
        <Text weight="semibold" numberOfLines={1} style={{ flexShrink: 1 }}>
          {o.payeeName}
        </Text>
        <Text weight="semibold" style={{ fontVariant: ["tabular-nums"] }}>
          {f.money(o.amountMinor, o.currency)}
        </Text>
      </Box>
      <Text variant="caption">
        {t("bills:dueOn", {
          date: f.date(o.dueDate),
          category: t(`common:category.${o.category}`, { defaultValue: o.category }),
        })}
      </Text>
      {settled && o.nextDueDate ? (
        <Text variant="caption" testID={`obligation-next-due-${o.id}`}>
          {t("bills:nextDue", { date: f.date(o.nextDueDate) })}
        </Text>
      ) : null}
      {!settled && o.bestRoute ? (
        <Text variant="caption">
          {t("bills:bestRoute", {
            from: o.bestRoute.fundingCurrency,
            rail: t(`common:rail.${o.bestRoute.rail}`),
            cost: f.money(o.bestRoute.costHomeMinor, homeCurrency),
          })}
        </Text>
      ) : null}
      <Box row gap={2} style={{ flexWrap: "wrap" }}>
        {periodLabel && o.status !== "DUE" ? (
          <StatusChip
            tone={PERIOD_TONE[o.status]}
            label={periodLabel}
            testID={`obligation-status-${o.id}`}
          />
        ) : null}
        {settled ? null : (
          <StatusChip tone={COVERAGE_TONE[o.coverage]} label={t(`bills:coverage.${o.coverage}`)} />
        )}
        {o.payeeAccountMissing ? (
          <StatusChip
            tone="warning"
            label={t("bills:needsPayeeDetails")}
            icon={{ sf: "person.crop.circle.badge.exclamationmark", md: "person_alert" }}
          />
        ) : o.payeeStatus !== "VERIFIED" ? (
          <StatusChip
            tone={o.payeeStatus === "COOLING" ? "warning" : "critical"}
            label={t(`payees:status.${o.payeeStatus}`)}
          />
        ) : null}
        {o.mandateId ? (
          <StatusChip
            tone="info"
            label={t("bills:autopay")}
            icon={{ sf: "arrow.triangle.2.circlepath", md: "autorenew" }}
          />
        ) : null}
      </Box>
      {o.payeeAccountMissing ? (
        <Text variant="caption">{t("bills:needsPayeeDetailsBody", { payee: o.payeeName })}</Text>
      ) : null}
      {o.status === "IN_FLIGHT" ? <Text variant="caption">{t("bills:inFlightBody")}</Text> : null}
      {!settled && o.coverage === "SHORTFALL" && !o.payeeAccountMissing ? (
        <Text variant="caption">{t("bills:shortfallBody", { currency: o.currency })}</Text>
      ) : null}
      {!settled && o.coverage === "CONVERTIBLE" && !o.payeeAccountMissing ? (
        <Text variant="caption" testID={`obligation-convert-plan-${o.id}`}>
          {steps.length > 0
            ? t("bills:convertPlan", {
                steps: steps
                  .map((s) =>
                    t("bills:convertStep", {
                      amount: f.money(s.amountMinor, s.toCurrency),
                      from: s.fromCurrency,
                    })
                  )
                  .join(t("bills:convertStepJoin")),
              })
            : t("bills:convertGeneric")}
        </Text>
      ) : null}
    </>
  );
  const style = { paddingHorizontal: 16, paddingVertical: 12, gap: 6, minHeight: 44 };
  // A bill whose payee has no account details (from the setup chat) links to the payee: that is where the
  // details are needed. Nothing can pay it until then (rules: PAYEE_ACCOUNT_MISSING).
  // Paid or on its way: nothing to add, convert or pay for this period.
  if (settled) return <View style={style}>{body}</View>;
  // An order for this bill waits for the passkey: open it.
  if (o.status === "AWAITING_APPROVAL" && o.proposalId) {
    return (
      <Pressable
        accessibilityRole="link"
        accessibilityHint={t("chat:reviewAndSign")}
        testID={`obligation-awaiting-${o.id}`}
        onPress={() => router.push(`/order/${o.proposalId}`)}
        style={style}
      >
        {body}
      </Pressable>
    );
  }
  if (o.payeeAccountMissing) {
    return (
      <Pressable
        accessibilityRole="link"
        accessibilityHint={t("bills:needsPayeeDetails")}
        testID={`obligation-needs-details-${o.id}`}
        onPress={() => router.push(`/payees/${o.payeeId}`)}
        style={style}
      >
        {body}
      </Pressable>
    );
  }
  // Not enough money in any one balance (the rules would refuse with INSUFFICIENT_FUNDS): open Add money.
  if (o.coverage === "SHORTFALL") {
    return (
      <Pressable
        accessibilityRole="link"
        accessibilityHint={t("home:addMoney")}
        testID={`obligation-shortfall-${o.id}`}
        onPress={() => router.push({ pathname: "/add-money", params: { currency: o.currency } })}
        style={style}
      >
        {body}
      </Pressable>
    );
  }
  // No single balance pays it, but converting does: open Convert with the plan's first step (each step is its own
  // passkey-signed CONVERT order; the bill is paid after, from its own currency).
  if (o.coverage === "CONVERTIBLE") {
    const first = steps[0];
    return (
      <Pressable
        accessibilityRole="link"
        accessibilityHint={t("wallet:convert.title")}
        testID={`obligation-convertible-${o.id}`}
        onPress={() =>
          router.push({
            pathname: "/convert",
            params: first
              ? {
                  fromCurrency: first.fromCurrency,
                  toCurrency: first.toCurrency,
                  amountMinor: String(first.amountMinor),
                }
              : { toCurrency: o.currency },
          })
        }
        style={style}
      >
        {body}
      </Pressable>
    );
  }
  return <View style={style}>{body}</View>;
}
