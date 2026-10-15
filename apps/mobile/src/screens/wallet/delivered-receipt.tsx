import { SimulatedBadge } from "@/components/kassa/badges";
import { Box, Card, Icon, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

/** "Delivered in 1.2 s": the measured time from approval to the bank reporting the money delivered. */
export function deliveredSeconds(ms: number): string {
  return (Math.max(ms, 100) / 1000).toFixed(1);
}

export function DeliveredReceipt({
  deliveredInMs,
  amountMinor,
  currency,
  payeeName,
  viaMandate = false,
}: {
  /** Undefined: sent, but the bank is still delivering it (no instant payout on this corridor). */
  deliveredInMs: number | undefined;
  amountMinor: number;
  currency: string;
  payeeName: string;
  viaMandate?: boolean;
}) {
  const t = useKassaT();
  const f = useFormat();
  const amount = f.money(amountMinor, currency);
  return (
    <Card>
      <Box gap={3} style={{ alignItems: "center", paddingVertical: 12 }} testID="delivered-receipt">
        <Icon name="checkmark.circle.fill" fallback="check-circle" size={56} color="success" />
        <Text variant="title" style={{ textAlign: "center" }}>
          {deliveredInMs !== undefined
            ? t("wallet:sent.title", { seconds: deliveredSeconds(deliveredInMs) })
            : t("wallet:sent.processing")}
        </Text>
        <Text variant="caption" style={{ textAlign: "center" }}>
          {t("wallet:sent.body", { amount, name: payeeName })}
        </Text>
        {viaMandate ? (
          <Text variant="caption" style={{ textAlign: "center" }}>
            {t("wallet:sent.auto")}
          </Text>
        ) : null}
        <SimulatedBadge />
      </Box>
    </Card>
  );
}
