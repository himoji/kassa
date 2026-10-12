import type { PurchaseOrderDto } from "@kassa/shared";
import { router } from "expo-router";
import { useState } from "react";

import { usePurchaseOrders, useSignPurchaseOrder } from "@/api/hooks/business";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { StatusChip } from "@/components/kassa/status-chip";
import { RowGroup } from "@/components/row-group";
import { Box, Button, Text, toast } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

import { poStatusTone } from "./business-text";

/**
 * Kassa Business "Orders": supplier purchase orders, newest first. Tap one for its detail: status timeline, Sign
 * (payments passkey, M5) for a draft, and the invoice payment in the order sheet once the invoice matched.
 */
export function OrdersScreen() {
  const t = useKassaT();
  const f = useFormat();
  const orders = usePurchaseOrders();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <ScrollScreen onRefresh={() => void orders.refetch()} refreshing={orders.isRefetching}>
      <QueryView
        query={orders}
        isEmpty={(o) => o.items.length === 0}
        empty={<Text variant="caption">{t("business:ordersEmpty")}</Text>}
      >
        {(o) => (
          <RowGroup footer={t("business:ordersFooter")}>
            {o.items.map((po) => (
              <Box key={po.id} p={4} gap={2} testID={`po-${po.id}`}>
                <Box row justify="between" align="center">
                  <Text weight="semibold">{po.supplierName}</Text>
                  <StatusChip
                    tone={poStatusTone(po.status)}
                    label={t(`business:status.${po.status}`)}
                  />
                </Box>
                <Text style={{ fontVariant: ["tabular-nums"] }}>
                  {f.money(po.totalMinor, po.currency)}
                </Text>
                <Text variant="caption">
                  {t("business:orderSubtitle", {
                    lines: po.lines
                      .map((l) => t("business:orderLine", { packs: l.packs, sku: l.supplierSku }))
                      .join(", "),
                    date: f.dateTime(po.createdAt),
                  })}
                </Text>
                <Text variant="caption">
                  {t(`business:createdBy.${po.createdBy}`, { defaultValue: po.createdBy })}
                </Text>
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => setOpen(open === po.id ? null : po.id)}
                >
                  {t(open === po.id ? "business:hideDetails" : "business:showDetails")}
                </Button>
                {open === po.id ? <PurchaseOrderDetail po={po} /> : null}
              </Box>
            ))}
          </RowGroup>
        )}
      </QueryView>
    </ScrollScreen>
  );
}

/** Detail of one purchase order: reasons, timeline, and the next owner action (sign / pay the invoice). */
function PurchaseOrderDetail({ po }: { po: PurchaseOrderDto }) {
  const t = useKassaT();
  const f = useFormat();
  const sign = useSignPurchaseOrder();
  return (
    <Box gap={2} testID={`po-detail-${po.id}`}>
      {po.reasonCodes.map((c) => (
        <Text key={c} variant="caption">
          {t(`reasonCodes:${c}.label`, { defaultValue: c })}
        </Text>
      ))}
      {(po.timeline ?? []).map((e, i) => (
        <Text key={`${e.status}-${i}`} variant="caption">
          {t("business:timelineEntry", {
            status: t(`business:status.${e.status}`, { defaultValue: e.status }),
            date: f.dateTime(e.at),
          })}
        </Text>
      ))}
      {po.invoice ? (
        <Text variant="caption">
          {t("business:invoiceLine", {
            id: po.invoice.invoiceId,
            amount: f.money(po.invoice.amountMinor, po.invoice.currency),
          })}
        </Text>
      ) : null}
      {po.status === "DRAFT" ? (
        <Button
          loading={sign.isPending}
          onPress={() =>
            sign.mutate(po.id, {
              onSuccess: (r) =>
                toast.show({
                  title: t(r.status === "SENT" ? "business:signedSent" : "business:signedNotSent"),
                  kind: "success",
                }),
              onError: (e) =>
                toast.show({
                  title: t("business:signFailed"),
                  description: e instanceof Error ? e.message : String(e),
                }),
            })
          }
        >
          {t("business:signWithPasskey")}
        </Button>
      ) : null}
      {po.proposalId && (po.status === "INVOICED" || po.status === "PAYING") ? (
        <Button variant="secondary" onPress={() => router.push(`/order/${po.proposalId}`)}>
          {t("business:reviewInvoicePayment")}
        </Button>
      ) : null}
    </Box>
  );
}
