/**
 * pay/[billId] (added 2026-10-14, Business M3): the customer scanned the counter till's QR code. The bill shown is
 * the one the merchant's till reports (fetched by the API); "Review and pay" asks the API to propose exactly that
 * bill and opens the usual order sheet, where the passkey approves it. Nothing here sends an amount.
 */
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";

import { useMerchantBill, useProposeBill } from "@/api/hooks/shop";
import { KassaApiError } from "@/api/errors";
import { SimulatedBadge } from "@/components/kassa/badges";
import { errorText } from "@/components/kassa/error-text";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { StatusChip } from "@/components/kassa/status-chip";
import { Box, Button, Card, Text } from "@/components/ui";
import { haptics } from "@/lib/haptics";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

export function PayBillScreen() {
  const t = useKassaT();
  const f = useFormat();
  const { billId = "" } = useLocalSearchParams<{ billId: string }>();
  const bill = useMerchantBill(billId);
  const propose = useProposeBill(billId);
  const [error, setError] = useState<string | null>(null);

  const onPay = async (merchant: string) => {
    setError(null);
    try {
      const r = await propose.mutateAsync();
      haptics.success();
      router.replace(`/order/${r.proposalId}`);
    } catch (err) {
      haptics.error();
      if (err instanceof KassaApiError && err.code === "MERCHANT_NOT_A_PAYEE")
        setError(t("shop:pay.notPayee", { merchant }));
      else if (err instanceof KassaApiError && err.code === "BILL_ALREADY_PAID")
        setError(t("shop:pay.paid"));
      else setError(errorText(t, err));
    }
  };

  return (
    <ScrollScreen onRefresh={() => void bill.refetch()} refreshing={bill.isRefetching}>
      <QueryView query={bill} skeletonRows={4}>
        {(b) => (
          <Box gap={5}>
            <SimulatedBadge />
            <Box gap={1} style={{ alignItems: "center" }}>
              <Text variant="caption">{t("shop:pay.from", { merchant: b.merchantName })}</Text>
              <Text variant="title" style={{ fontVariant: ["tabular-nums"] }}>
                {f.money(b.totalMinor, b.currency)}
              </Text>
            </Box>
            <Card>
              <Box gap={2}>
                {b.items.map((i) => (
                  <Box key={i.sku} row justify="between" gap={3}>
                    <Text style={{ flexShrink: 1 }}>
                      {t("shop:item", { qty: i.qty, name: i.name ?? i.sku })}
                    </Text>
                    <Text style={{ fontVariant: ["tabular-nums"] }}>
                      {f.money(i.qty * i.unitPriceMinor, b.currency)}
                    </Text>
                  </Box>
                ))}
              </Box>
            </Card>
            <Text variant="caption">{t("shop:pay.hint")}</Text>
            {b.status === "PAID" ? (
              <StatusChip tone="positive" label={t("shop:status.PAID")} />
            ) : (
              <Button onPress={() => void onPay(b.merchantName)} loading={propose.isPending}>
                {t("shop:pay.review")}
              </Button>
            )}
            {error ? <Text color="destructive">{error}</Text> : null}
          </Box>
        )}
      </QueryView>
    </ScrollScreen>
  );
}
