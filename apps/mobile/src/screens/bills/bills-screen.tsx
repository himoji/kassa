import { useMe } from "@/api/hooks/me";
import { useForecast, useObligations } from "@/api/hooks/money";
import { ObligationRow } from "@/components/kassa/obligation-row";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { StatusChip } from "@/components/kassa/status-chip";
import { RowGroup } from "@/components/row-group";
import { Box, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

/** Upcoming bills, and the coverage forecast with FX suggestions (spec §12, §16 Home). */
export function BillsScreen() {
  const t = useKassaT();
  const f = useFormat();
  const obligations = useObligations();
  const me = useMe();
  const forecast = useForecast();
  const homeCurrency = me.data?.homeCurrency ?? "KZT";

  return (
    <ScrollScreen
      onRefresh={() => {
        void obligations.refetch();
        void forecast.refetch();
      }}
      refreshing={obligations.isRefetching || forecast.isRefetching}
    >
      <QueryView
        query={obligations}
        isEmpty={(o) => o.obligations.length === 0}
        empty={<Text variant="caption">{t("bills:empty")}</Text>}
      >
        {(o) => (
          <RowGroup title={t("bills:upcomingTitle")}>
            {o.obligations.map((obligation) => (
              <ObligationRow
                key={obligation.id}
                obligation={obligation}
                homeCurrency={homeCurrency}
              />
            ))}
          </RowGroup>
        )}
      </QueryView>

      {forecast.data && forecast.data.currencies.length > 0 ? (
        <Box gap={3}>
          <RowGroup title={t("bills:forecastTitle")} footer={t("bills:forecastFooter")}>
            {forecast.data.currencies.map((c) => (
              <Box key={c.currency} p={4} gap={2}>
                <Text weight="semibold">{c.currency}</Text>
                {c.shortfall ? (
                  <StatusChip
                    tone="critical"
                    label={t("bills:shortfall", {
                      date: f.date(c.shortfall.date),
                      amount: f.money(c.shortfall.amountMinor, c.currency),
                    })}
                  />
                ) : (
                  <StatusChip tone="positive" label={t("bills:covered45")} />
                )}
              </Box>
            ))}
          </RowGroup>
          {forecast.data.suggestions.length > 0 ? (
            <Box gap={2} px={4}>
              {forecast.data.suggestions.map((s) => (
                <Text key={`${s.fromCurrency}-${s.toCurrency}-${s.byDate}`} variant="caption">
                  {t("bills:suggestion", {
                    amount: f.money(s.amountMinor, s.toCurrency),
                    from: s.fromCurrency,
                    to: s.toCurrency,
                    date: f.date(s.byDate),
                  })}
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
      ) : null}
    </ScrollScreen>
  );
}
