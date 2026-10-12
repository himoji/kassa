import { router } from "expo-router";

import { useBusinessForecast, useSalesToday } from "@/api/hooks/business";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { StatusChip } from "@/components/kassa/status-chip";
import { Box, Button, Card, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

import { qtyText } from "./business-text";

/** Kassa Business "Today": sales so far today and the shortage alert from the stock forecast (Business M4). */
export function TodayScreen() {
  const t = useKassaT();
  const f = useFormat();
  const sales = useSalesToday();
  const forecast = useBusinessForecast();

  return (
    <ScrollScreen
      onRefresh={() => {
        void sales.refetch();
        void forecast.refetch();
      }}
      refreshing={sales.isRefetching || forecast.isRefetching}
    >
      <QueryView query={sales} skeletonRows={2}>
        {(s) => (
          <Card>
            <Box gap={2} testID="business-sales-today">
              <Text variant="caption">
                {t("business:salesDay", { merchant: s.merchant.name, date: f.date(s.day) })}
              </Text>
              <Text
                variant="title"
                style={{ fontSize: 34, lineHeight: 40, fontVariant: ["tabular-nums"] }}
              >
                {f.money(s.revenueMinor, s.merchant.currency)}
              </Text>
              <Text>
                {s.totalUnits > 0
                  ? t("business:salesUnits", { count: s.totalUnits })
                  : t("business:salesEmpty")}
              </Text>
            </Box>
          </Card>
        )}
      </QueryView>

      <QueryView query={forecast} skeletonRows={2}>
        {(fc) =>
          fc.shortages.length > 0 ? (
            <Card>
              <Box gap={3} testID="business-shortage-alert">
                <StatusChip tone="critical" label={t("business:shortageTitle")} />
                {fc.shortages.map((l) => (
                  <Box key={l.sku} gap={1}>
                    <Text weight="semibold">
                      {t("business:shortageLine", {
                        name: l.name,
                        qty: qtyText(l.shortage, l.unit, t, f.locale),
                      })}
                    </Text>
                    {l.suggestion ? (
                      <Text variant="caption">
                        {t("business:shortageSuggestion", {
                          packs: l.suggestion.packs,
                          packSize: qtyText(l.suggestion.packSize, l.unit, t, f.locale),
                          supplier: l.suggestion.supplierName,
                          amount: f.money(l.suggestion.lineTotalMinor, l.suggestion.currency),
                        })}
                      </Text>
                    ) : null}
                    {l.suggestion && !l.suggestion.verified ? (
                      <Text variant="caption" color="destructive">
                        {t("business:shortageCooling")}
                      </Text>
                    ) : null}
                    {l.suggestion?.late ? (
                      <Text variant="caption" color="destructive">
                        {t("business:shortageLate")}
                      </Text>
                    ) : null}
                  </Box>
                ))}
                <Button variant="outline" onPress={() => router.push("/orders")}>
                  {t("business:viewOrders")}
                </Button>
              </Box>
            </Card>
          ) : (
            <Card>
              <Box gap={2} testID="business-covered">
                <StatusChip tone="positive" label={t("business:coveredTitle")} />
                <Text variant="caption">
                  {t("business:coveredBody", { date: f.date(fc.tomorrow) })}
                </Text>
              </Box>
            </Card>
          )
        }
      </QueryView>
    </ScrollScreen>
  );
}
