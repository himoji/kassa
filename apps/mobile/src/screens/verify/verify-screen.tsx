import { useLocalSearchParams } from "expo-router";

import { useVerifyRecord } from "@/api/hooks/records";
import { SimulatedBadge } from "@/components/kassa/badges";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { StatusChip } from "@/components/kassa/status-chip";
import { RowGroup } from "@/components/row-group";
import { Box, Card, Row, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

/** Public verification of a credit record (spec §8). No session needed. */
export function VerifyScreen() {
  const t = useKassaT();
  const f = useFormat();
  const { id = "" } = useLocalSearchParams<{ id: string }>();
  const record = useVerifyRecord(id);

  return (
    <ScrollScreen onRefresh={() => void record.refetch()} refreshing={record.isRefetching}>
      <QueryView query={record} skeletonRows={3}>
        {(data) => (
          <>
            <Card>
              <Box gap={3}>
                <Box row justify="between" align="center" gap={2}>
                  {data.valid ? (
                    <StatusChip tone="positive" label={t("credit:valid")} />
                  ) : (
                    <StatusChip tone="critical" label={t("credit:invalid")} />
                  )}
                  {data.simulated ? <SimulatedBadge /> : null}
                </Box>
              </Box>
            </Card>

            <RowGroup title={t("credit:verifyDetails")}>
              <Row title={t("credit:holder")} trailing={<Text selectable>{data.holder}</Text>} />
              <Row
                title={t("credit:verifyPeriod")}
                trailing={
                  <Text selectable>
                    {t("credit:periodRange", {
                      from: f.date(data.period.from),
                      to: f.date(data.period.to),
                    })}
                  </Text>
                }
              />
              <Row
                title={t("credit:issuedAt")}
                trailing={<Text selectable>{f.dateTime(data.issuedAt)}</Text>}
              />
              <Row
                title={t("credit:billsOnTime")}
                trailing={
                  <Text selectable>
                    {t("credit:billsOnTimeValue", {
                      paid: data.summary.billsPaidOnTime,
                      total: data.summary.billsTotal,
                    })}
                  </Text>
                }
              />
              <Row
                title={t("credit:monthsCovered")}
                trailing={<Text selectable>{String(data.summary.monthsCovered)}</Text>}
              />
              <Row
                title={t("credit:regularIncome")}
                trailing={<Text selectable>{String(data.summary.regularIncomeMonths)}</Text>}
              />
              <Row
                title={t("credit:included")}
                trailing={
                  <Text selectable>{data.items.map((i) => t(`credit:item.${i}`)).join(", ")}</Text>
                }
              />
              <Row title={t("credit:keyId")} trailing={<Text selectable>{data.keyId}</Text>} />
              <Row title={t("credit:sha256")} trailing={<Text selectable>{data.sha256}</Text>} />
            </RowGroup>

            <Text variant="caption">{t("credit:verifyExplainer")}</Text>
          </>
        )}
      </QueryView>
    </ScrollScreen>
  );
}
