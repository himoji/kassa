import type { PayeeDto } from "@kassa/shared";
import { useLocalSearchParams } from "expo-router";

import { useSimulatePayeeVerification, usePayees } from "@/api/hooks/payees";
import { SimulatedBadge } from "@/components/kassa/badges";
import { Countdown } from "@/components/kassa/countdown";
import { errorText } from "@/components/kassa/error-text";
import { PayeeStatusChip } from "@/components/kassa/payee-status";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { RowGroup } from "@/components/row-group";
import { Box, Button, Card, EmptyState, Icon, Row, Text, toast } from "@/components/ui";
import { haptics } from "@/lib/haptics";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

function PayeeDetail({ payee, replaced }: { payee: PayeeDto; replaced: PayeeDto | undefined }) {
  const t = useKassaT();
  const f = useFormat();
  const simulate = useSimulatePayeeVerification();

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
          {payee.status === "COOLING" && payee.coolingUntil ? (
            <Box gap={1}>
              <Countdown until={payee.coolingUntil} prefixKey="payees:coolingEndsIn" />
              <Text variant="caption">{t("payees:coolingRule")}</Text>
            </Box>
          ) : null}
        </Box>
      </Card>

      <RowGroup title={t("payees:detailsTitle")}>
        <Row
          title={t("payees:field.kind")}
          trailing={<Text selectable>{t(`payees:kind.${payee.kind}`)}</Text>}
        />
        <Row
          title={t("payees:field.account")}
          trailing={<Text selectable>{payee.accountMasked}</Text>}
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

      {payee.status === "COOLING" ? (
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
