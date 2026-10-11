import type { RouteDto } from "@kassa/shared";

import { Box, Card, Divider, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

import { StatusChip } from "./status-chip";

interface RouteComparisonProps {
  routes: readonly RouteDto[];
  homeCurrency: string;
  amountMinor: number;
  toCurrency: string;
}

/** Ranked funding routes from the optimizer (spec §12); the first is the cheapest. */
export function RouteComparison({
  routes,
  homeCurrency,
  amountMinor,
  toCurrency,
}: RouteComparisonProps) {
  const t = useKassaT();
  const f = useFormat();
  return (
    <Card>
      <Box gap={3}>
        <Text weight="semibold">
          {t("chat:routesTitle", { amount: f.money(amountMinor, toCurrency) })}
        </Text>
        {routes.map((route, i) => (
          <Box key={route.routeId} gap={1}>
            {i > 0 ? <Divider spacing={2} /> : null}
            <Box row justify="between" align="center" gap={2}>
              <Text style={{ flexShrink: 1 }}>
                {t("chat:routeLabel", {
                  from: route.fundingCurrency,
                  rail: t(`common:rail.${route.rail}`),
                })}
              </Text>
              {i === 0 ? <StatusChip tone="positive" label={t("chat:cheapest")} /> : null}
            </Box>
            <Text variant="caption">
              {t("chat:routeCost", {
                cost: f.money(route.costHomeMinor, homeCurrency),
                markup: f.bps(route.markupBps),
                arrival: f.date(route.arrivalDate),
              })}
            </Text>
            {i === 0 && route.savingsVsWorstHomeMinor > 0 ? (
              <Text variant="caption" weight="semibold">
                {t("chat:routeSavings", {
                  amount: f.money(route.savingsVsWorstHomeMinor, homeCurrency),
                })}
              </Text>
            ) : null}
          </Box>
        ))}
      </Box>
    </Card>
  );
}
