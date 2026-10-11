/**
 * Confirmation sheet body (spec §7 T2, §16, I3). It renders ONLY:
 * - fields of the server's `canonicalOrder` (payee, amounts, rail, purpose, expiry),
 * - the server's payee status badge and budget impact,
 * - "Signed order ID" = first 8 characters of the orderHash.
 * It never renders agent prose, the chat transcript or any client-composed description, and it
 * takes the `OrderView` as parsed by the shared zod schema (unknown keys stripped). If the order,
 * its hash and the passkey challenge disagree, Approve is disabled.
 */
import type { OrderView, PayeeStatus } from "@kassa/shared";
import { View } from "react-native";

import { verifyOrderIntegrity } from "@/api/hooks/orders";
import { BudgetImpactView } from "@/components/kassa/budget-impact";
import { Countdown } from "@/components/kassa/countdown";
import { StatusChip } from "@/components/kassa/status-chip";
import { Box, Button, Divider, Icon, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";
import type { StatusTone } from "@/theme/status";

export const PAYEE_TONE: Record<PayeeStatus, StatusTone> = {
  VERIFIED: "positive",
  COOLING: "warning",
  BLOCKED: "critical",
};

export interface OrderSheetViewProps {
  view: OrderView;
  onApprove: () => void;
  onReject: () => void;
  approving?: boolean;
  rejecting?: boolean;
  /** Translated error from the last action, if any. */
  errorMessage?: string | null;
}

function Field({ label, value, testID }: { label: string; value: string; testID?: string }) {
  return (
    <Box row justify="between" gap={4} style={{ minHeight: 28, alignItems: "flex-start" }}>
      <Text variant="caption">{label}</Text>
      <Text testID={testID} style={{ flexShrink: 1, textAlign: "right" }}>
        {value}
      </Text>
    </Box>
  );
}

export function OrderSheetView({
  view,
  onApprove,
  onReject,
  approving = false,
  rejecting = false,
  errorMessage,
}: OrderSheetViewProps) {
  const t = useKassaT();
  const f = useFormat();
  const order = view.canonicalOrder;
  const intact = verifyOrderIntegrity(view);
  const pending = view.status === "PENDING_APPROVAL";
  const canApprove =
    pending && intact && view.webauthnOptions !== null && view.payeeStatus !== "BLOCKED";

  return (
    <View style={{ flex: 1, padding: 20, gap: 20 }} testID="order-sheet">
      <Box gap={1}>
        <Text variant="caption">{t("order:title")}</Text>
        <Box row align="center" gap={2}>
          <Text variant="title" testID="order-payee" style={{ flexShrink: 1 }}>
            {order.payeeName}
          </Text>
        </Box>
        <StatusChip
          tone={PAYEE_TONE[view.payeeStatus]}
          label={t(`payees:status.${view.payeeStatus}`)}
          testID="order-payee-status"
        />
      </Box>

      <Box gap={1} style={{ alignItems: "center" }}>
        <Text
          variant="title"
          testID="order-amount"
          style={{ fontSize: 34, lineHeight: 40, fontVariant: ["tabular-nums"] }}
        >
          {f.money(order.amountMinor, order.currency)}
        </Text>
        {order.currency !== order.homeCurrency ? (
          <Text variant="caption" testID="order-home-amount">
            {t("common:approxHome", { amount: f.money(order.homeAmountMinor, order.homeCurrency) })}
          </Text>
        ) : null}
      </Box>

      <Box gap={2}>
        <Field label={t("order:rail")} value={t(`common:rail.${order.rail}`)} testID="order-rail" />
        <Field label={t("order:purpose")} value={order.purpose} testID="order-purpose" />
        {order.mandateId ? (
          <Field label={t("order:mandate")} value={t("order:withinMandate")} />
        ) : null}
        <Field
          label={t("order:signedOrderId")}
          value={view.orderHash.slice(0, 8)}
          testID="order-signed-id"
        />
        <Box row justify="between" gap={4}>
          <Text variant="caption">{t("order:expires")}</Text>
          <Countdown until={order.expiresAt} />
        </Box>
      </Box>

      {view.budgetImpact ? (
        <>
          <Divider spacing={0} />
          <BudgetImpactView impact={view.budgetImpact} />
        </>
      ) : null}

      {!intact ? (
        <Box row gap={2} align="center" testID="order-integrity-error">
          <Icon
            name="exclamationmark.triangle.fill"
            fallback="warning"
            size={18}
            color="destructive"
          />
          <Text color="destructive" style={{ flexShrink: 1 }}>
            {t("order:integrityError")}
          </Text>
        </Box>
      ) : null}
      {!pending ? (
        <Text variant="caption" testID="order-status">
          {t(`common:proposalStatus.${view.status}`)}
        </Text>
      ) : null}
      {errorMessage ? (
        <Text color="destructive" testID="order-error">
          {errorMessage}
        </Text>
      ) : null}

      <View style={{ flex: 1 }} />

      <Box gap={3}>
        <Button
          size="lg"
          onPress={onApprove}
          loading={approving}
          disabled={!canApprove || rejecting}
          leftIcon={
            <Icon name="faceid" fallback="fingerprint" size={20} color="primaryForeground" />
          }
        >
          {t("order:approve")}
        </Button>
        <Button
          size="lg"
          variant="outline"
          onPress={onReject}
          loading={rejecting}
          disabled={!pending || approving}
        >
          {t("order:reject")}
        </Button>
        <Text variant="caption" align="center">
          {t("order:passkeyNote")}
        </Text>
      </Box>
    </View>
  );
}
