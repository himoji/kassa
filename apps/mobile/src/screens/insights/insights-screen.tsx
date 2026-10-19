import type { SpendingInsightsResponse } from "@kassa/shared";
import { router, type Href } from "expo-router";
import { View } from "react-native";

import { useSpendingInsights } from "@/api/hooks/insights";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import {
  categoryLabel,
  categorySlices,
  DailyBars,
  ShareBar,
  Swatch,
} from "@/components/kassa/spend-charts";
import { StatusChip } from "@/components/kassa/status-chip";
import { RowGroup } from "@/components/row-group";
import { Box, Card, EmptyState, Icon, Text, useTheme } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";
import { statusColor } from "@/theme/status";

import { insightHighlights, type Highlight } from "./highlights";

type T = ReturnType<typeof useKassaT>;
type F = ReturnType<typeof useFormat>;

function comparison(data: SpendingInsightsResponse, t: T, f: F): string | null {
  if (data.lastMonthToDateMinor === null) return null;
  const diff = data.totalMinor - data.lastMonthToDateMinor;
  // Within 5 % of last month is "about the same".
  if (Math.abs(diff) * 20 <= Math.max(data.lastMonthToDateMinor, 1)) {
    return t("insights:month.vsLastMonthSame");
  }
  const amount = f.money(Math.abs(diff), data.homeCurrency);
  return diff > 0
    ? t("insights:month.vsLastMonthMore", { amount })
    : t("insights:month.vsLastMonthLess", { amount });
}

/**
 * The month at a glance: what was spent, against this point last month, where the pace leads. With `onPress` it is
 * the entry to the insights screen (Activity's header).
 */
export function MonthSummaryCard({
  data,
  onPress,
}: {
  data: SpendingInsightsResponse;
  onPress?: () => void;
}) {
  const t = useKassaT();
  const f = useFormat();
  const { colors } = useTheme();
  const vs = comparison(data, t, f);
  const up = data.lastMonthToDateMinor !== null && data.totalMinor > data.lastMonthToDateMinor;
  return (
    <Card onPress={onPress}>
      <Box gap={2}>
        <Box row justify="between" align="center" gap={3}>
          <Text variant="caption">
            {t("insights:month.spentLabel", { month: f.monthName(data.month.start) })}
          </Text>
          <Text variant="caption">
            {t("insights:month.daysLeft", { count: data.month.daysLeft })}
          </Text>
        </Box>
        <Text
          variant="title"
          style={{ fontSize: 34, lineHeight: 40, fontVariant: ["tabular-nums"] }}
          accessibilityLabel={t("insights:month.a11y", {
            amount: f.money(data.totalMinor, data.homeCurrency),
            count: data.count,
          })}
          testID="month-total"
        >
          {f.money(data.totalMinor, data.homeCurrency)}
        </Text>
        <Text variant="caption">
          {[
            t("insights:month.purchases", { count: data.count }),
            data.count > 0
              ? t("insights:month.perDay", {
                  amount: f.money(
                    Math.round(data.totalMinor / Math.max(1, data.month.daysElapsed)),
                    data.homeCurrency
                  ),
                })
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
        {vs ? (
          <Box row gap={2} align="center">
            <Icon
              name={up ? "arrow.up.right" : "arrow.down.right"}
              fallback={up ? "trending_up" : "trending_down"}
              size={14}
              color={up ? "destructive" : "mutedForeground"}
            />
            <Text variant="caption" style={{ flexShrink: 1, color: colors.foreground }}>
              {vs}
            </Text>
          </Box>
        ) : null}
        {data.daily.length >= 3 && data.month.daysLeft > 1 ? (
          <Text variant="caption">
            {t("insights:month.projected", {
              amount: f.money(data.projectedMinor, data.homeCurrency),
              date: f.dayMonth(data.month.end),
            })}
          </Text>
        ) : null}
        {onPress ? (
          <Box row align="center" justify="between" pt={1}>
            <Text weight="semibold" style={{ color: colors.brandAccent }}>
              {t("insights:month.open")}
            </Text>
            <Icon name="chevron.forward" fallback="chevron_right" size={16} color="brandAccent" />
          </Box>
        ) : null}
      </Box>
    </Card>
  );
}

function highlightText(h: Highlight, data: SpendingInsightsResponse, t: T, f: F): string {
  const money = (m: number) => f.money(m, data.homeCurrency);
  switch (h.kind) {
    case "overBudget":
      return t("insights:highlights.overBudget", {
        category: categoryLabel(t, h.category),
        amount: money(h.amountMinor),
      });
    case "fastBudget":
      return t("insights:highlights.fastBudget", {
        category: categoryLabel(t, h.category),
        amount: money(h.amountMinor),
        days: h.days,
      });
    case "aboveUsual":
      return t("insights:highlights.aboveUsual", {
        category: categoryLabel(t, h.category),
        amount: money(h.amountMinor),
      });
    case "bigShare":
      return t("insights:highlights.bigShare", {
        category: categoryLabel(t, h.category),
        pct: h.pct,
      });
    case "projectedOverIncome":
      return t("insights:highlights.projectedOverIncome");
    case "quietMonth":
      return t("insights:highlights.quietMonth");
  }
}

const HIGHLIGHT_TONE = {
  overBudget: "critical",
  fastBudget: "warning",
  projectedOverIncome: "warning",
  aboveUsual: "info",
  bigShare: "info",
  quietMonth: "positive",
} as const;

function Highlights({ data }: { data: SpendingInsightsResponse }) {
  const t = useKassaT();
  const f = useFormat();
  const { mode } = useTheme();
  const list = insightHighlights(data);
  if (list.length === 0) return null;
  return (
    <RowGroup title={t("insights:highlights.title")}>
      {list.map((h, i) => {
        const tone = HIGHLIGHT_TONE[h.kind];
        return (
          <Box key={`${h.kind}-${i}`} p={4} row gap={3} align="center">
            <View
              style={{
                width: 8,
                alignSelf: "stretch",
                borderRadius: 4,
                backgroundColor: statusColor(tone, mode),
              }}
            />
            <Text style={{ flexShrink: 1 }}>{highlightText(h, data, t, f)}</Text>
          </Box>
        );
      })}
    </RowGroup>
  );
}

function Categories({ data }: { data: SpendingInsightsResponse }) {
  const t = useKassaT();
  const f = useFormat();
  const { mode } = useTheme();
  const slices = categorySlices(data.categories, t, mode);
  const unspentBudgets = data.categories.filter((c) => c.spentMinor === 0 && c.budget);
  if (slices.length === 0 && unspentBudgets.length === 0) return null;
  return (
    <RowGroup
      title={t("insights:categories.title")}
      footer={
        data.outsideBudgetsMinor > 0
          ? t("insights:categories.outsideBudgets", {
              amount: f.money(data.outsideBudgetsMinor, data.homeCurrency),
            })
          : undefined
      }
    >
      {slices.length > 0 ? (
        <Box p={4}>
          <ShareBar slices={slices} />
        </Box>
      ) : null}
      {slices.map((s) => {
        const b = s.category?.budget;
        const typical = s.category?.typicalMinor ?? null;
        const detail = b
          ? b.remainingMinor < 0
            ? t("insights:categories.over", {
                amount: f.money(-b.remainingMinor, data.homeCurrency),
                limit: f.money(b.limitMinor, data.homeCurrency),
              })
            : t("insights:categories.left", {
                amount: f.money(b.remainingMinor, data.homeCurrency),
                limit: f.money(b.limitMinor, data.homeCurrency),
              })
          : typical !== null
            ? t("insights:categories.usual", { amount: f.money(typical, data.homeCurrency) })
            : s.category
              ? t("insights:categories.noBudget")
              : null;
        return (
          <View
            key={s.key}
            accessible
            accessibilityLabel={t("insights:categories.a11y", {
              category: s.label,
              amount: f.money(s.spentMinor, data.homeCurrency),
              pct: s.pct,
            })}
            style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 4 }}
          >
            <Box row align="center" gap={3}>
              <Swatch color={s.color} />
              <Text weight="semibold" numberOfLines={1} style={{ flex: 1 }}>
                {s.label}
              </Text>
              <Text variant="caption">{t("insights:categories.share", { pct: s.pct })}</Text>
              <Text weight="semibold" style={{ fontVariant: ["tabular-nums"] }}>
                {f.money(s.spentMinor, data.homeCurrency)}
              </Text>
            </Box>
            {detail ? (
              <Box row align="center" gap={2} style={{ paddingStart: 22 }}>
                <Text variant="caption" style={{ flexShrink: 1 }}>
                  {detail}
                </Text>
                {b && b.pace !== "ON_TRACK" ? (
                  <StatusChip
                    tone={b.pace === "OVER" ? "critical" : "warning"}
                    label={t(`home:pace.${b.pace}`)}
                  />
                ) : null}
              </Box>
            ) : null}
          </View>
        );
      })}
      {unspentBudgets.map((c) => (
        <View key={c.category} style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 4 }}>
          <Box row align="center" gap={3}>
            <Swatch color="transparent" />
            <Text weight="semibold" numberOfLines={1} style={{ flex: 1 }}>
              {categoryLabel(t, c.category)}
            </Text>
            <Text weight="semibold" style={{ fontVariant: ["tabular-nums"] }}>
              {f.money(0, data.homeCurrency)}
            </Text>
          </Box>
          <Text variant="caption" style={{ paddingStart: 22 }}>
            {t("insights:categories.left", {
              amount: f.money(c.budget!.remainingMinor, data.homeCurrency),
              limit: f.money(c.budget!.limitMinor, data.homeCurrency),
            })}
          </Text>
        </View>
      ))}
    </RowGroup>
  );
}

function Merchants({ data }: { data: SpendingInsightsResponse }) {
  const t = useKassaT();
  const f = useFormat();
  if (data.topMerchants.length === 0) return null;
  return (
    <RowGroup title={t("insights:merchants.title")}>
      {data.topMerchants.map((m, i) => (
        <Box key={`${m.name}-${i}`} px={4} py={3} row align="center" gap={3}>
          <Text variant="caption" style={{ width: 16, fontVariant: ["tabular-nums"] }}>
            {String(i + 1)}
          </Text>
          <Box flex={1} gap={1}>
            <Text weight="semibold" numberOfLines={1}>
              {m.name}
            </Text>
            <Text variant="caption">{t("insights:merchants.row", { count: m.count })}</Text>
          </Box>
          <Text weight="semibold" style={{ fontVariant: ["tabular-nums"] }}>
            {f.money(m.spentMinor, data.homeCurrency)}
          </Text>
        </Box>
      ))}
    </RowGroup>
  );
}

export function InsightsBody({ data }: { data: SpendingInsightsResponse }) {
  const t = useKassaT();
  const f = useFormat();
  const extras = [
    data.typicalMonthMinor !== null
      ? t("insights:month.usual", { amount: f.money(data.typicalMonthMinor, data.homeCurrency) })
      : null,
    data.incomeUsedPct !== null
      ? t("insights:month.incomeUsed", { pct: data.incomeUsedPct })
      : null,
  ].filter((x): x is string => x !== null);
  return (
    <>
      <MonthSummaryCard data={data} />
      {data.totalMinor === 0 ? (
        <EmptyState title={t("insights:empty.title")} description={t("insights:empty.body")} />
      ) : (
        <>
          <Highlights data={data} />
          <RowGroup title={t("insights:daily.title")} footer={extras.join(" · ") || undefined}>
            <Box p={4}>
              <DailyBars days={data.daily} currency={data.homeCurrency} />
            </Box>
          </RowGroup>
        </>
      )}
      <Categories data={data} />
      <Merchants data={data} />
    </>
  );
}

/** This month's spending: the headline, what is worth knowing, day by day, by category, by merchant. */
export function InsightsScreen() {
  const insights = useSpendingInsights();
  return (
    <ScrollScreen onRefresh={() => insights.refetch()}>
      <QueryView query={insights} skeletonRows={5}>
        {(data) => <InsightsBody data={data} />}
      </QueryView>
    </ScrollScreen>
  );
}

/** Where the month summary card leads (a tab in KassaLite, a pushed screen in the full app). */
export const INSIGHTS_HREF = "/insights" as Href;

export function openInsights() {
  router.push(INSIGHTS_HREF);
}
