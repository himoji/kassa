import type { ObligationDto } from "@kassa/shared";
import { View } from "react-native";

import { Box, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

import { StatusChip } from "./status-chip";

/** One upcoming bill: amount, due date, best route, coverage and payee status (spec §16 Home). */
export function ObligationRow({
  obligation,
  homeCurrency,
}: {
  obligation: ObligationDto;
  homeCurrency: string;
}) {
  const t = useKassaT();
  const f = useFormat();
  const o = obligation;
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 6, minHeight: 44 }}>
      <Box row justify="between" gap={3}>
        <Text weight="semibold" numberOfLines={1} style={{ flexShrink: 1 }}>
          {o.payeeName}
        </Text>
        <Text weight="semibold" style={{ fontVariant: ["tabular-nums"] }}>
          {f.money(o.amountMinor, o.currency)}
        </Text>
      </Box>
      <Text variant="caption">
        {t("bills:dueOn", {
          date: f.date(o.dueDate),
          category: t(`common:category.${o.category}`, { defaultValue: o.category }),
        })}
      </Text>
      {o.bestRoute ? (
        <Text variant="caption">
          {t("bills:bestRoute", {
            from: o.bestRoute.fundingCurrency,
            rail: t(`common:rail.${o.bestRoute.rail}`),
            cost: f.money(o.bestRoute.costHomeMinor, homeCurrency),
          })}
        </Text>
      ) : null}
      <Box row gap={2} style={{ flexWrap: "wrap" }}>
        <StatusChip
          tone={o.coverage === "COVERED" ? "positive" : "critical"}
          label={t(`bills:coverage.${o.coverage}`)}
        />
        {o.payeeStatus !== "VERIFIED" ? (
          <StatusChip
            tone={o.payeeStatus === "COOLING" ? "warning" : "critical"}
            label={t(`payees:status.${o.payeeStatus}`)}
          />
        ) : null}
        {o.mandateId ? (
          <StatusChip
            tone="info"
            label={t("bills:autopay")}
            icon={{ sf: "arrow.triangle.2.circlepath", md: "autorenew" }}
          />
        ) : null}
      </Box>
    </View>
  );
}
