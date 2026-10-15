import { suggestedReference, type PayeeDto, type RecipientDetails } from "@kassa/shared";
import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";

import { KassaApiError } from "@/api/errors";
import { useRemovePayee, useSimulatePayeeVerification, usePayees } from "@/api/hooks/payees";
import { SimulatedBadge } from "@/components/kassa/badges";
import { Countdown } from "@/components/kassa/countdown";
import { errorText } from "@/components/kassa/error-text";
import { PayeeStatusChip } from "@/components/kassa/payee-status";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { RowGroup } from "@/components/row-group";
import { Box, Button, Card, EmptyState, Icon, Row, Text, toast } from "@/components/ui";
import { confirm } from "@/lib/confirm";
import { haptics } from "@/lib/haptics";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

import { EditDetailsSheet, ScheduleSheet } from "./recipient-sheets";

/** The category's details as label/value rows (only what was filled in). */
function detailRows(
  t: ReturnType<typeof useKassaT>,
  d: RecipientDetails | null
): { label: string; value: string }[] {
  if (!d) return [];
  const rows: { label: string; value: string | undefined }[] =
    d.category === "PEOPLE"
      ? [
          {
            label: t("payees:details.relationship"),
            value: t(`payees:relationship.${d.relationship}`),
          },
          { label: t("payees:details.note"), value: d.note },
          { label: t("payees:details.purposeCode"), value: d.purposeCode },
        ]
      : d.category === "TUITION"
        ? [
            { label: t("payees:details.studentId"), value: d.studentId },
            { label: t("payees:details.term"), value: d.term },
          ]
        : d.category === "RENT"
          ? [
              { label: t("payees:details.rentReference"), value: d.reference },
              { label: t("payees:details.dueDay"), value: d.dueDay ? String(d.dueDay) : undefined },
            ]
          : d.category === "BILLS"
            ? [
                { label: t("payees:details.billType"), value: t(`payees:billType.${d.billType}`) },
                { label: t("payees:details.customerNumber"), value: d.customerNumber },
                { label: t("payees:details.billReference"), value: d.reference },
              ]
            : [{ label: t("payees:details.shopNote"), value: d.note }];
  return rows.filter((r): r is { label: string; value: string } => Boolean(r.value));
}

function PayeeDetail({ payee, replaced }: { payee: PayeeDto; replaced: PayeeDto | undefined }) {
  const t = useKassaT();
  const f = useFormat();
  const simulate = useSimulatePayeeVerification();
  const remove = useRemovePayee();
  const [editing, setEditing] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const payable = !payee.accountMissing && payee.status !== "BLOCKED" && payee.category !== "SHOPS";
  const portalUrl = payee.details?.category === "TUITION" ? payee.details.portalUrl : undefined;
  const reference = suggestedReference(payee.details);

  const onRemove = async () => {
    const ok = await confirm({
      title: t("payees:actions.remove"),
      message: t("payees:actions.removeConfirm", { name: payee.name }),
      confirmLabel: t("payees:actions.remove"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(payee.id);
      haptics.success();
      toast.show({ title: t("payees:actions.removed"), kind: "success" });
      router.back();
    } catch (err) {
      haptics.error();
      const hasBills = err instanceof KassaApiError && err.code === "PAYEE_HAS_BILLS";
      toast.show({
        title: hasBills ? t("payees:actions.hasBills") : errorText(t, err),
        kind: "error",
      });
    }
  };

  const onSimulate = async () => {
    try {
      await simulate.mutateAsync(payee.id);
      haptics.success();
      toast.show({ title: t("payees:simulateVerifyDone"), kind: "success" });
    } catch (err) {
      haptics.error();
      toast.show({ title: errorText(t, err), kind: "error" });
    }
  };

  return (
    <>
      <Card>
        <Box gap={2}>
          <Text variant="title">{payee.name}</Text>
          <PayeeStatusChip payee={payee} />
          {payee.accountMissing ? (
            <Text variant="caption" testID="payee-account-missing">
              {t("payees:accountMissingBody")}
            </Text>
          ) : null}
          {payee.status === "COOLING" && payee.coolingUntil ? (
            <Box gap={1}>
              <Countdown until={payee.coolingUntil} prefixKey="payees:coolingEndsIn" />
              <Text variant="caption">{t("payees:coolingRule")}</Text>
            </Box>
          ) : null}
        </Box>
      </Card>

      {payable || portalUrl ? (
        <Box gap={2}>
          {payable ? (
            <Button
              size="lg"
              onPress={() => router.push(`/send?payeeId=${encodeURIComponent(payee.id)}`)}
            >
              {t("payees:actions.send")}
            </Button>
          ) : null}
          {portalUrl ? (
            <Button
              variant="outline"
              onPress={() => void WebBrowser.openBrowserAsync(portalUrl).catch(() => {})}
            >
              {t("payees:actions.openPortal")}
            </Button>
          ) : null}
        </Box>
      ) : null}

      <RowGroup title={t("payees:detailsTitle")}>
        <Row
          title={t("payees:field.category")}
          trailing={<Text selectable>{t(`payees:category.${payee.category}`)}</Text>}
        />
        {detailRows(t, payee.details).map((r) => (
          <Row key={r.label} title={r.label} trailing={<Text selectable>{r.value}</Text>} />
        ))}
        {reference ? (
          <Row title={t("payees:field.reference")} trailing={<Text selectable>{reference}</Text>} />
        ) : null}
        <Row
          title={t("payees:field.account")}
          trailing={
            <Text selectable>
              {payee.accountMissing ? t("payees:accountNotAdded") : payee.accountMasked}
            </Text>
          }
        />
        <Row title={t("payees:field.country")} trailing={<Text selectable>{payee.country}</Text>} />
        <Row
          title={t("payees:field.currency")}
          trailing={<Text selectable>{payee.currency}</Text>}
        />
        <Row
          title={t("payees:field.verifiedAt")}
          trailing={
            <Text selectable>
              {payee.verifiedAt ? f.dateTime(payee.verifiedAt) : t("payees:never")}
            </Text>
          }
        />
      </RowGroup>

      {payee.replacesPayeeId ? (
        <Card>
          <Box row gap={3} align="center">
            <Icon
              name="arrow.triangle.branch"
              fallback="call_split"
              size={22}
              color="mutedForeground"
            />
            <Box flex={1} gap={1}>
              <Text weight="semibold">{t("payees:newPayeeExplainer")}</Text>
              {replaced ? (
                <Text variant="caption">
                  {t("payees:replaces", { name: replaced.name, account: replaced.accountMasked })}
                </Text>
              ) : null}
            </Box>
          </Box>
        </Card>
      ) : null}

      <RowGroup>
        <Row
          title={t("payees:actions.edit")}
          onPress={() => setEditing(true)}
          testID="recipient-edit"
        />
        {payable ? (
          <Row
            title={t("payees:actions.schedule")}
            onPress={() => setScheduling(true)}
            testID="recipient-schedule"
          />
        ) : null}
        <Row
          title={t("payees:actions.remove")}
          onPress={() => void onRemove()}
          testID="recipient-remove"
        />
      </RowGroup>
      <EditDetailsSheet payee={payee} visible={editing} onClose={() => setEditing(false)} />
      <ScheduleSheet payee={payee} visible={scheduling} onClose={() => setScheduling(false)} />

      {/* Nothing to verify without account details (the server refuses: PAYEE_ACCOUNT_MISSING). */}
      {payee.status === "COOLING" && !payee.accountMissing ? (
        <Box gap={3}>
          <Box row>
            <SimulatedBadge />
          </Box>
          <Button
            variant="outline"
            size="lg"
            loading={simulate.isPending}
            onPress={() => void onSimulate()}
          >
            {t("payees:simulateVerify")}
          </Button>
        </Box>
      ) : null}
    </>
  );
}

/** One payee: status with countdown while cooling (I7), details, and the replaced payee (I7 history). */
export function PayeeDetailScreen() {
  const t = useKassaT();
  const { id = "" } = useLocalSearchParams<{ id: string }>();
  const payees = usePayees();

  return (
    <ScrollScreen onRefresh={() => void payees.refetch()} refreshing={payees.isRefetching}>
      <QueryView query={payees} skeletonRows={3}>
        {(data) => {
          const payee = data.payees.find((p) => p.id === id);
          if (!payee) return <EmptyState title={t("payees:notFound")} />;
          const replaced = payee.replacesPayeeId
            ? data.payees.find((p) => p.id === payee.replacesPayeeId)
            : undefined;
          return <PayeeDetail payee={payee} replaced={replaced} />;
        }}
      </QueryView>
    </ScrollScreen>
  );
}
