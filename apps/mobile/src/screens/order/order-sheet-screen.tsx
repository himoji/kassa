import type { ApproveOrderResponse } from "@kassa/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView } from "react-native";

import { OrderReissuedError, useApproveOrder, useOrder, useRejectOrder } from "@/api/hooks/orders";
import { errorText } from "@/components/kassa/error-text";
import { QueryView } from "@/components/kassa/query-view";
import { StatusChip } from "@/components/kassa/status-chip";
import { PayInPlace } from "@/components/pay/pay-in-place";
import { Box, Button, Text, toast, useTheme } from "@/components/ui";
import { haptics } from "@/lib/haptics";
import { PasskeyCancelledError } from "@/lib/passkey-errors";
import { useKassaT } from "@/lib/i18n";

import { OrderSheetView } from "./order-sheet-view";

/** order/[proposalId] - native form sheet (presentation set in the root layout). */
export function OrderSheetScreen() {
  const t = useKassaT();
  const { colors } = useTheme();
  const { proposalId = "" } = useLocalSearchParams<{ proposalId: string }>();
  const query = useOrder(proposalId);
  const approve = useApproveOrder(proposalId);
  const reject = useRejectOrder(proposalId);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ApproveOrderResponse | null>(null);

  const close = () => (router.canGoBack() ? router.back() : router.replace("/home"));

  const onApprove = async () => {
    if (!query.data) return;
    setError(null);
    try {
      const result = await approve.mutateAsync(query.data);
      haptics.success();
      const rail = query.data.canonicalOrder.rail;
      if (rail === "HANDOFF" && result.paymentId) {
        router.replace(`/handoff/${result.paymentId}`);
        return;
      }
      if (rail === "PAY_IN_PLACE" && result.paymentId) {
        setOutcome(result);
        return;
      }
      toast.show({ title: t("order:approvedToast"), kind: "success" });
      close();
    } catch (err) {
      if (err instanceof PasskeyCancelledError) {
        haptics.warning();
        return;
      }
      if (err instanceof OrderReissuedError) {
        // The sheet now shows the re-issued order (reissued banner); approving it is a new, explicit tap.
        haptics.warning();
        setError(t("order:reissuedError"));
        return;
      }
      haptics.error();
      setError(errorText(t, err));
    }
  };

  const onReject = async () => {
    setError(null);
    try {
      await reject.mutateAsync();
      haptics.warning();
      toast.show({ title: t("order:rejectedToast") });
      close();
    } catch (err) {
      haptics.error();
      setError(errorText(t, err));
    }
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ flexGrow: 1 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      {outcome?.paymentId ? (
        <Box p={5} gap={4}>
          <StatusChip tone="positive" label={t("order:approvedChip")} />
          <Text variant="heading">{t("order:payInPlaceTitle")}</Text>
          <PayInPlace paymentId={outcome.paymentId} onDone={close} />
          <Button variant="ghost" onPress={close}>
            {t("common:close")}
          </Button>
        </Box>
      ) : (
        <QueryView query={query} skeletonRows={6}>
          {(view) => (
            <OrderSheetView
              view={view}
              onApprove={() => void onApprove()}
              onReject={() => void onReject()}
              approving={approve.isPending}
              rejecting={reject.isPending}
              errorMessage={error}
            />
          )}
        </QueryView>
      )}
    </ScrollView>
  );
}
