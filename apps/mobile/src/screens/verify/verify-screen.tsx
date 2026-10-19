import { useLocalSearchParams } from "expo-router";
import { useState } from "react";

import { useCheckHolderName, useVerifyRecord } from "@/api/hooks/records";
import { SimulatedBadge } from "@/components/kassa/badges";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { StatusChip } from "@/components/kassa/status-chip";
import { RowGroup } from "@/components/row-group";
import { Box, Button, Card, Input, Row, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

/** Public verification of a credit record (spec §8). No session needed. */
export function VerifyScreen() {
  const t = useKassaT();
  const f = useFormat();
  const { id = "" } = useLocalSearchParams<{ id: string }>();
  const record = useVerifyRecord(id);
  const checkName = useCheckHolderName(id);
  const [name, setName] = useState("");

  return (
    <ScrollScreen onRefresh={() => record.refetch()}>
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
              {data.requestedPeriod &&
              (data.requestedPeriod.from !== data.period.from ||
                data.requestedPeriod.to !== data.period.to) ? (
                <Row
                  title={t("credit:requestedPeriod")}
                  trailing={
                    <Text selectable>
                      {t("credit:periodRange", {
                        from: f.date(data.requestedPeriod.from),
                        to: f.date(data.requestedPeriod.to),
                      })}
                    </Text>
                  }
                />
              ) : null}
              {data.accountOpenedOn ? (
                <Row
                  title={t("credit:accountOpened")}
                  trailing={<Text selectable>{f.date(data.accountOpenedOn)}</Text>}
                />
              ) : null}
              {data.summary.billsTotal !== undefined ? (
                <Row
                  title={t("credit:billsOnTime")}
                  trailing={
                    <Text selectable>
                      {t("credit:billsOnTimeValue", {
                        paid: data.summary.billsPaidOnTime ?? 0,
                        total: data.summary.billsTotal,
                      })}
                    </Text>
                  }
                />
              ) : null}
              <Row
                title={t("credit:monthsCovered")}
                trailing={<Text selectable>{String(data.summary.monthsCovered)}</Text>}
              />
              {data.summary.incomeMonths !== undefined ? (
                <Row
                  title={t("credit:incomeMonths")}
                  trailing={<Text selectable>{String(data.summary.incomeMonths)}</Text>}
                />
              ) : null}
              {data.summary.budgetsTotal !== undefined ? (
                <Row
                  title={t("credit:budgetsKept")}
                  trailing={
                    <Text selectable>
                      {t("credit:billsOnTimeValue", {
                        paid: data.summary.budgetsWithinLimit ?? 0,
                        total: data.summary.budgetsTotal,
                      })}
                    </Text>
                  }
                />
              ) : null}
              {data.summary.paymentsCompleted !== undefined ? (
                <Row
                  title={t("credit:paymentsCompleted")}
                  trailing={<Text selectable>{String(data.summary.paymentsCompleted)}</Text>}
                />
              ) : null}
              {data.summary.paymentsOnTimePct !== undefined ? (
                <Row
                  title={t("credit:paymentsOnTime")}
                  trailing={
                    <Text selectable>{f.percent(data.summary.paymentsOnTimePct / 100)}</Text>
                  }
                />
              ) : null}
              {data.summary.regularIncomeMonths !== undefined ? (
                <Row
                  title={t("credit:regularIncome")}
                  trailing={<Text selectable>{String(data.summary.regularIncomeMonths)}</Text>}
                />
              ) : null}
              <Row
                title={t("credit:included")}
                trailing={
                  <Text selectable>{data.items.map((i) => t(`credit:item.${i}`)).join(", ")}</Text>
                }
              />
              <Row title={t("credit:keyId")} trailing={<Text selectable>{data.keyId}</Text>} />
              <Row title={t("credit:sha256")} trailing={<Text selectable>{data.sha256}</Text>} />
            </RowGroup>

            {data.holderNameSource ? (
              <RowGroup
                title={t("credit:nameTitle")}
                footer={t(
                  data.holderNameSource === "KYC"
                    ? "credit:nameFooterKyc"
                    : "credit:nameFooterProfile"
                )}
              >
                <Box p={4} gap={3}>
                  <Input
                    value={name}
                    onChangeText={(v) => {
                      setName(v);
                      checkName.reset();
                    }}
                    placeholder={t("credit:namePlaceholder")}
                    autoCapitalize="words"
                  />
                  <Button
                    variant="secondary"
                    loading={checkName.isPending}
                    disabled={name.trim().length === 0}
                    onPress={() => checkName.mutate(name.trim())}
                  >
                    {t("credit:nameCheck")}
                  </Button>
                  {checkName.data === true ? (
                    <StatusChip tone="positive" label={t("credit:nameMatch")} />
                  ) : checkName.data === false ? (
                    <StatusChip tone="critical" label={t("credit:nameNoMatch")} />
                  ) : null}
                </Box>
              </RowGroup>
            ) : null}

            {data.importedHistory ? (
              <Text variant="caption">
                {t("credit:importedHistory", { date: f.date(data.importedHistory.openedOn) })}
              </Text>
            ) : null}
            <Text variant="caption">{t("credit:verifyExplainer")}</Text>
          </>
        )}
      </QueryView>
    </ScrollScreen>
  );
}
