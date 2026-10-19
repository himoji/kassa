import type { Decision, ProposalSummary } from "@kassa/shared";
import { router } from "expo-router";
import { View } from "react-native";

import { Box, Button, Card, Text, useTheme } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";
import type { StatusTone } from "@/theme/status";

import { ReasonCodeList } from "./reason-codes";
import { StatusChip } from "./status-chip";

export const DECISION_TONE: Record<Decision, StatusTone> = {
  AUTO: "positive",
  ASK: "info",
  HANDOFF: "warning",
  REFUSE: "critical",
};

type Format = ReturnType<typeof useFormat>;
type T = ReturnType<typeof useKassaT>;

/**
 * (2026-10-19) The order in one sentence, in the user's language, from the card's structured fields (`orderFacts`,
 * the same canonical order the server's English `orderLine` is built from). Null without them: the English line is
 * shown as it came (cards stored before the fields existed).
 */
export function localizedOrderLine(p: ProposalSummary, t: T, f: Format): string | null {
  const o = p.orderFacts;
  if (!o) return null;
  if (o.conversion) {
    const c = o.conversion;
    return t("chat:orderLine.convert", {
      from: c.fromCurrency,
      to: c.toCurrency,
      amount: f.money(c.amountMinor, c.toCurrency),
      max: f.money(c.maxDebitMinor, c.fromCurrency),
      route: c.routeId,
    });
  }
  const pay = t("chat:orderLine.pay", {
    amount: f.money(p.amountMinor, p.currency),
    payee: p.payeeName,
  });
  if (p.funding) {
    return t(o.linkedAccount ? "chat:orderLine.fundedLinked" : "chat:orderLine.funded", {
      pay,
      currency: p.funding.currency,
      max: f.money(p.funding.maxAmountMinor, p.funding.currency),
      route: p.funding.routeId,
    });
  }
  return t("chat:orderLine.rail", { pay, rail: t(`common:rail.${o.rail}`) });
}

/**
 * Proposal summary card (chat, home). Server fields only; the "Review and sign" button opens the
 * confirmation sheet, which re-fetches the canonical order (I3) - this card is never signed.
 * (2026-10-18) The signed funding balance and the server's sentence of the signed order (`orderLine`) are shown
 * as they come, so the balance the user reads is the one the order debits, never the assistant's paraphrase.
 * (2026-10-19) The block is headed by where the order stands ("Order to sign", "Paid under your mandate", …), never
 * "what you sign" for an order that was refused (none) or paid without the passkey, and worded in the app's language.
 */
export function ProposalCard({ proposal }: { proposal: ProposalSummary }) {
  const t = useKassaT();
  const f = useFormat();
  const { colors } = useTheme();
  const canSign = proposal.decision === "ASK" && proposal.status === "PENDING_APPROVAL";
  const converts = proposal.kind === "CONVERT";
  // Same-currency funding says nothing the amount does not: only another balance gets its own row.
  const funding =
    proposal.funding && proposal.funding.currency !== proposal.currency ? proposal.funding : null;
  // A refused order is not an order anyone signs or pays: no order block.
  const refused = proposal.decision === "REFUSE";
  const stance = proposal.orderFacts?.stance ?? null;
  const orderLine = refused
    ? null
    : (localizedOrderLine(proposal, t, f) ?? proposal.orderLine ?? null);
  return (
    <Card>
      <Box gap={3}>
        <Box row justify="between" align="center" gap={2}>
          <Text
            weight="semibold"
            numberOfLines={1}
            style={{ flexShrink: 1 }}
            testID="proposal-title"
          >
            {converts
              ? t("chat:proposalConvertTitle", { currency: proposal.currency })
              : proposal.payeeName}
          </Text>
          <StatusChip
            tone={DECISION_TONE[proposal.decision]}
            label={t(`common:decision.${proposal.decision}`)}
          />
        </Box>
        <Box gap={1}>
          <Text variant="heading" style={{ fontVariant: ["tabular-nums"] }}>
            {f.money(proposal.amountMinor, proposal.currency)}
          </Text>
          {proposal.currency !== proposal.homeCurrency ? (
            <Text variant="caption">
              {t("common:approxHome", {
                amount: f.money(proposal.homeAmountMinor, proposal.homeCurrency),
              })}
            </Text>
          ) : null}
          {funding ? (
            <Text variant="caption" weight="semibold" testID="proposal-funding">
              {t("chat:proposalFunding", {
                currency: funding.currency,
                max: f.money(funding.maxAmountMinor, funding.currency),
              })}
            </Text>
          ) : null}
          <Text variant="caption">{t(`common:proposalStatus.${proposal.status}`)}</Text>
        </Box>
        {orderLine ? (
          <View
            testID="proposal-order-line"
            style={{
              gap: 2,
              paddingLeft: 10,
              borderLeftWidth: 3,
              borderLeftColor: colors.brandAccent,
            }}
          >
            {stance ? (
              <Text variant="caption" testID="proposal-order-stance">
                {t(`chat:orderStance.${stance}`)}
              </Text>
            ) : null}
            <Text selectable>{orderLine}</Text>
          </View>
        ) : null}
        {proposal.decision === "REFUSE" ? <ReasonCodeList codes={proposal.reasonCodes} /> : null}
        {canSign ? (
          <Button onPress={() => router.push(`/order/${proposal.proposalId}`)}>
            {t("chat:reviewAndSign")}
          </Button>
        ) : null}
      </Box>
    </Card>
  );
}
