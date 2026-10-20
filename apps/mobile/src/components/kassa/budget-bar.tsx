import type { BudgetDto } from "@kassa/shared";
import { View } from "react-native";

import { Box, Card, Icon, Text, useTheme } from "@/components/ui";
import { categoryEmoji } from "@/lib/category-emoji";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";
import { statusColor, type StatusTone } from "@/theme/status";

import { StatusChip } from "./status-chip";

export const PACE_TONE: Record<BudgetDto["pace"], StatusTone> = {
  ON_TRACK: "positive",
  AHEAD_OF_PACE: "warning",
  OVER: "critical",
};

/** Worst first: over budget, then spending fast, then on track (then by how much of the limit is gone). */
const PACE_ORDER: Record<BudgetDto["pace"], number> = { OVER: 0, AHEAD_OF_PACE: 1, ON_TRACK: 2 };

export function sortBudgets(budgets: readonly BudgetDto[]): BudgetDto[] {
  const used = (b: BudgetDto) => (b.limitHomeMinor > 0 ? b.spentHomeMinor / b.limitHomeMinor : 1);
  return [...budgets].sort((a, b) => PACE_ORDER[a.pace] - PACE_ORDER[b.pace] || used(b) - used(a));
}

/** A rounded progress bar: `ratio` of the track filled in the tone's colour (capped at full). */
export function Bar({ ratio, tone, height }: { ratio: number; tone: StatusTone; height: number }) {
  const { colors, mode } = useTheme();
  return (
    <View
      style={{
        height,
        borderRadius: height / 2,
        backgroundColor: colors.muted,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          width: `${Math.min(100, Math.max(0, ratio * 100))}%`,
          height,
          borderRadius: height / 2,
          backgroundColor: statusColor(tone, mode),
        }}
      />
    </View>
  );
}

/**
 * The month at a glance (spec §13, §16): what is left of all budgets together, one bar, the days left once, and how
 * many budgets need attention. Amounts come from the server; display only.
 */
export function BudgetsSummary({
  budgets,
  homeCurrency,
}: {
  budgets: readonly BudgetDto[];
  homeCurrency: string;
}) {
  const t = useKassaT();
  const f = useFormat();
  const limit = budgets.reduce((s, b) => s + b.limitHomeMinor, 0);
  const spent = budgets.reduce((s, b) => s + b.spentHomeMinor, 0);
  const left = limit - spent;
  const over = budgets.filter((b) => b.pace === "OVER").length;
  const fast = budgets.filter((b) => b.pace === "AHEAD_OF_PACE").length;
  const tone: StatusTone = left < 0 || over > 0 ? "critical" : fast > 0 ? "warning" : "positive";
  const daysLeft = budgets[0]?.daysLeft ?? 0;
  return (
    <Card>
      <Box gap={3}>
        <Box row justify="between" align="center" gap={3}>
          <Text variant="caption">{t("home:budgetSummary.leftThisMonth")}</Text>
          <Text variant="caption">{t("home:daysLeft", { count: daysLeft })}</Text>
        </Box>
        <Text
          variant="title"
          style={{ fontSize: 28, lineHeight: 34, fontVariant: ["tabular-nums"] }}
          accessibilityLabel={t("home:budgetSummary.a11y", {
            left: f.money(left, homeCurrency),
            spent: f.money(spent, homeCurrency),
            limit: f.money(limit, homeCurrency),
          })}
        >
          {f.money(left, homeCurrency)}
        </Text>
        <Bar ratio={limit > 0 ? spent / limit : 1} tone={tone} height={10} />
        <Box row justify="between" align="center" gap={3}>
          <Text variant="caption">
            {t("home:spentOf", {
              spent: f.money(spent, homeCurrency),
              limit: f.money(limit, homeCurrency),
            })}
          </Text>
          {over + fast > 0 ? (
            <StatusChip
              tone={over > 0 ? "critical" : "warning"}
              label={t("home:budgetSummary.attention", { count: over + fast })}
            />
          ) : (
            <StatusChip tone="positive" label={t("home:pace.ON_TRACK")} />
          )}
        </Box>
      </Box>
    </Card>
  );
}

/** One budget as a compact row: emoji, name and pace, what is left, a thin bar (spec §13, §16). */
export function BudgetBar({ budget, homeCurrency }: { budget: BudgetDto; homeCurrency: string }) {
  const t = useKassaT();
  const f = useFormat();
  const { colors, mode } = useTheme();
  const ratio = budget.limitHomeMinor > 0 ? budget.spentHomeMinor / budget.limitHomeMinor : 1;
  const tone = PACE_TONE[budget.pace];
  const category = t(`common:category.${budget.category}`, {
    defaultValue: budget.category.replace(/_/g, " "),
  });
  const left = budget.limitHomeMinor - budget.spentHomeMinor;

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={t("home:budgetA11y", {
        category,
        spent: f.money(budget.spentHomeMinor, homeCurrency),
        limit: f.money(budget.limitHomeMinor, homeCurrency),
      })}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(Math.min(1, ratio) * 100) }}
      style={{ flexDirection: "row", gap: 12, alignItems: "center", paddingVertical: 10 }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.muted,
        }}
      >
        <Text style={{ fontSize: 20 }}>{categoryEmoji(budget.category)}</Text>
      </View>
      <View style={{ flex: 1, gap: 6 }}>
        <Box row justify="between" align="center" gap={2}>
          <Box row align="center" gap={1} style={{ flexShrink: 1 }}>
            <Text weight="semibold" numberOfLines={1} style={{ flexShrink: 1 }}>
              {category}
            </Text>
            {budget.pace !== "ON_TRACK" ? (
              <Icon
                name="exclamationmark.circle.fill"
                fallback="error"
                size={14}
                color={budget.pace === "OVER" ? "destructive" : "mutedForeground"}
              />
            ) : null}
          </Box>
          <Text
            weight="semibold"
            style={{
              fontVariant: ["tabular-nums"],
              color: left < 0 ? statusColor("critical", mode) : colors.foreground,
            }}
          >
            {left < 0
              ? t("home:budgetRow.over", { amount: f.money(-left, homeCurrency) })
              : t("home:budgetRow.left", { amount: f.money(left, homeCurrency) })}
          </Text>
        </Box>
        <Bar ratio={ratio} tone={tone} height={6} />
        <Box row justify="between" gap={2}>
          <Text variant="caption">
            {t("home:spentOf", {
              spent: f.money(budget.spentHomeMinor, homeCurrency),
              limit: f.money(budget.limitHomeMinor, homeCurrency),
            })}
          </Text>
          {budget.projectedRunOutDate && budget.pace !== "ON_TRACK" ? (
            <Text variant="caption" style={{ color: statusColor(tone, mode) }}>
              {t("home:runOutShort", { date: f.date(budget.projectedRunOutDate) })}
            </Text>
          ) : budget.pace !== "ON_TRACK" ? (
            <Text variant="caption" style={{ color: statusColor(tone, mode) }}>
              {t(`home:pace.${budget.pace}`)}
            </Text>
          ) : null}
        </Box>
      </View>
    </View>
  );
}
