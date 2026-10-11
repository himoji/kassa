import type { Decision, ProposalSummary } from "@kassa/shared";
import { router } from "expo-router";

import { Box, Button, Card, Text } from "@/components/ui";
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

/**
 * Proposal summary card (chat, home). Server fields only; the "Review and sign" button opens the
 * confirmation sheet, which re-fetches the canonical order (I3) - this card is never signed.
 */
export function ProposalCard({ proposal }: { proposal: ProposalSummary }) {
  const t = useKassaT();
  const f = useFormat();
  const canSign = proposal.decision === "ASK" && proposal.status === "PENDING_APPROVAL";
  return (
    <Card>
      <Box gap={3}>
        <Box row justify="between" align="center" gap={2}>
          <Text weight="semibold" numberOfLines={1} style={{ flexShrink: 1 }}>
            {proposal.payeeName}
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
          <Text variant="caption">{t(`common:proposalStatus.${proposal.status}`)}</Text>
        </Box>
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
