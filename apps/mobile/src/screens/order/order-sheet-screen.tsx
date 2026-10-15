import type { ApproveOrderResponse } from "@kassa/shared";
import * as Linking from "expo-linking";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView } from "react-native";

import { OrderReissuedError, useApproveOrder, useOrder, useRejectOrder } from "@/api/hooks/orders";
import { useShopOrderOfProposal } from "@/api/hooks/shop";
import { errorText } from "@/components/kassa/error-text";
import { QueryView } from "@/components/kassa/query-view";
import { StatusChip } from "@/components/kassa/status-chip";
import { PayInPlace } from "@/components/pay/pay-in-place";
import { Box, Button, Text, toast, useTheme } from "@/components/ui";
import { haptics } from "@/lib/haptics";
import { PasskeyCancelledError } from "@/lib/passkey-errors";
import { useKassaT } from "@/lib/i18n";
import { approveInWebAppUrl, LITE_RETURN_URL } from "@/lite/approve";

import { ShopOrderTimeline } from "../shop/shop-order-timeline";
import { DeliveredReceipt } from "../wallet/delivered-receipt";
import { OrderSheetView } from "./order-sheet-view";

/** order/[proposalId] - native form sheet (presentation set in the root layout). */
export function OrderSheetScreen() {
  const t = useKassaT();
  const { colors } = useTheme();
  // `from=lite`: opened from KassaLite (its approval link); after approving, send the person back there.
  const { proposalId = "", from } = useLocalSearchParams<{ proposalId: string; from?: string }>();
  const fromLite = from === "lite";
  const [backToLite, setBackToLite] = useState(false);
  useEffect(() => {
    if (backToLite) void Linking.openURL(`${LITE_RETURN_URL}order/${proposalId}`).catch(() => {});
  }, [backToLite, proposalId]);
  const query = useOrder(proposalId);
  const approve = useApproveOrder(proposalId);
  const reject = useRejectOrder(proposalId);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ApproveOrderResponse | null>(null);
  // A bank transfer the bank already delivered (instant payout): the receipt with the measured time.
  const [delivered, setDelivered] = useState<{
    result: ApproveOrderResponse;
    amountMinor: number;
    currency: string;
    payeeName: string;
  } | null>(null);
  // (M2/M3) A merchant order (signed itemsHash): after approval the sheet stays open on the shop's status timeline.
  const [tracking, setTracking] = useState(false);
  const shopOrder = useShopOrderOfProposal(proposalId, { poll: tracking });

  const close = () => (router.canGoBack() ? router.back() : router.replace("/home"));

  const onApprove = async () => {
    if (!query.data) return;
    setError(null);
    try {
      const result = await approve.mutateAsync(query.data);
      haptics.success();
      if (fromLite) {
        // KassaLite shows the outcome; this page only sends the person back (the auth session closes on it).
        setBackToLite(true);
        return;
      }
      const rail = query.data.canonicalOrder.rail;
      if (rail === "HANDOFF" && result.paymentId) {
        router.replace(`/handoff/${result.paymentId}`);
        return;
      }
      if (rail === "PAY_IN_PLACE" && result.paymentId) {
        setOutcome(result);
        return;
      }
      if (rail === "BANK_TRANSFER" && result.paymentStatus === "SENT") {
        const o = query.data.canonicalOrder;
        setDelivered({
          result,
          amountMinor: o.amountMinor,
          currency: o.currency,
          payeeName: o.payeeName,
        });
        return;
      }
      if (query.data.canonicalOrder.itemsHash && result.paymentId) {
        toast.show({ title: t("order:approvedToast"), kind: "success" });
        setTracking(true);
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
      // KassaLite: the web app opened for the passkey (lite/approve.ts).
      if (approveInWebAppUrl(err)) {
        haptics.warning();
        setError(t("lite:approve.opened"));
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
      {backToLite ? (
        <Box p={5} gap={3}>
          <StatusChip tone="positive" label={t("order:approvedChip")} />
          <Text>{t("lite:approve.backHint")}</Text>
          <Button
            size="lg"
            onPress={() =>
              void Linking.openURL(`${LITE_RETURN_URL}order/${proposalId}`).catch(() => {})
            }
          >
            {t("lite:approve.back")}
          </Button>
        </Box>
      ) : null}
      {backToLite ? null : shopOrder.data ? (
        <Box p={5} gap={4}>
          <Text variant="heading">{t("shop:timelineTitle")}</Text>
          <ShopOrderTimeline order={shopOrder.data} testID="shop-order-timeline" />
          {tracking || shopOrder.data.final ? (
            <Button variant="ghost" onPress={close}>
              {t("common:close")}
            </Button>
          ) : null}
        </Box>
      ) : null}
      {backToLite ? null : tracking && !shopOrder.data ? (
        <Box p={5} gap={4}>
          <StatusChip tone="positive" label={t("order:approvedChip")} />
          <Text variant="caption">{t("shop:timelineHint")}</Text>
        </Box>
      ) : tracking ? null : delivered ? (
        <Box p={5} gap={4}>
          <DeliveredReceipt
            deliveredInMs={delivered.result.deliveredInMs}
            amountMinor={delivered.amountMinor}
            currency={delivered.currency}
            payeeName={delivered.payeeName}
          />
          <Button size="lg" onPress={close}>
            {t("common:close")}
          </Button>
        </Box>
      ) : outcome?.paymentId ? (
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
