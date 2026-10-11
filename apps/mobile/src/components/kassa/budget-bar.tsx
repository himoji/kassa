import type { BudgetDto } from "@kassa/shared";
import { View } from "react-native";

import { Box, Text, useTheme } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";
import { statusColor, type StatusTone } from "@/theme/status";

import { StatusChip } from "./status-chip";

const PACE_TONE: Record<BudgetDto["pace"], StatusTone> = {
  ON_TRACK: "positive",
  AHEAD_OF_PACE: "warning",
  OVER: "critical",
};

/** Budget bar with pace (spec §13, §16). Ratios come from server amounts; display only. */
export function BudgetBar({ budget, homeCurrency }: { budget: BudgetDto; homeCurrency: string }) {
  const t = useKassaT();
  const f = useFormat();
  const { colors, mode } = useTheme();
  const ratio = budget.limitHomeMinor > 0 ? budget.spentHomeMinor / budget.limitHomeMinor : 1;
  const width = `${Math.min(100, Math.max(0, ratio * 100))}%` as const;
  const tone = PACE_TONE[budget.pace];
  const category = t(`common:category.${budget.category}`, { defaultValue: budget.category });

  return (
    <Box gap={2}>
      <Box row justify="between" align="center">
        <Text weight="semibold">{category}</Text>
        <StatusChip tone={tone} label={t(`home:pace.${budget.pace}`)} />
      </Box>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={t("home:budgetA11y", {
          category,
          spent: f.money(budget.spentHomeMinor, homeCurrency),
          limit: f.money(budget.limitHomeMinor, homeCurrency),
        })}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(Math.min(1, ratio) * 100) }}
        style={{ height: 8, borderRadius: 4, backgroundColor: colors.muted, overflow: "hidden" }}
      >
        <View
          style={{ width, height: 8, borderRadius: 4, backgroundColor: statusColor(tone, mode) }}
        />
      </View>
      <Box row justify="between">
        <Text variant="caption">
          {t("home:spentOf", {
            spent: f.money(budget.spentHomeMinor, homeCurrency),
            limit: f.money(budget.limitHomeMinor, homeCurrency),
          })}
        </Text>
        <Text variant="caption">{t("home:daysLeft", { count: budget.daysLeft })}</Text>
      </Box>
      {budget.projectedRunOutDate && budget.pace !== "ON_TRACK" ? (
        <Text variant="caption">
          {t("home:runOut", { date: f.date(budget.projectedRunOutDate) })}
        </Text>
      ) : null}
    </Box>
  );
}
