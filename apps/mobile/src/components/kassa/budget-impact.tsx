import type { BudgetImpact } from "@kassa/shared";

import { Box, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

/** Budget impact as computed by the server (spec §16 - the client does no money maths). */
export function BudgetImpactView({ impact }: { impact: BudgetImpact }) {
  const t = useKassaT();
  const f = useFormat();
  const category = t(`common:category.${impact.category}`, { defaultValue: impact.category });
  return (
    <Box gap={1} testID="budget-impact">
      <Text weight="semibold">{t("order:budgetImpactTitle", { category })}</Text>
      <Text variant="caption">
        {t("order:budgetImpactLine", {
          before: f.money(impact.remainingBeforeHomeMinor, impact.homeCurrency),
          after: f.money(impact.remainingAfterHomeMinor, impact.homeCurrency),
          limit: f.money(impact.limitHomeMinor, impact.homeCurrency),
        })}
      </Text>
      <Text variant="caption">{t("home:daysLeft", { count: impact.daysLeft })}</Text>
    </Box>
  );
}
