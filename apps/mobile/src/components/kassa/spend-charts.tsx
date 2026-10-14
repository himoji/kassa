import type { CategoryInsight, SpendingInsightsResponse } from "@kassa/shared";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { Box, Text, useTheme } from "@/components/ui";
import { categoryEmoji } from "@/lib/category-emoji";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";
import type { ResolvedMode } from "@/theme/tokens";

/*
 * Small native charts for the insights screens, drawn with plain views (no chart library): a day-by-day bar chart
 * and a category share bar with its legend. Identity is never colour alone: every colour sits next to a label.
 */

/** The dataviz reference categorical palette (validated light and dark steps), in its fixed order. */
const SERIES: Record<ResolvedMode, readonly string[]> = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};
const OTHER: Record<ResolvedMode, string> = { light: "#a3a3a3", dark: "#6b6b6b" };

/** A colour follows the category, never its rank: the common ones own a slot. */
const SLOT: Record<string, number> = {
  groceries: 0,
  eating_out: 1,
  transport: 2,
  shopping: 3,
  fun: 4,
  entertainment: 4,
  health: 5,
  subscriptions: 6,
  travel: 7,
};

/** Categories shown by name in the share bar; the rest fold into "Everything else". */
export const SHOWN_CATEGORIES = 5;

export function categoryColor(category: string, mode: ResolvedMode, taken: Set<number>): string {
  const own = SLOT[category];
  if (own !== undefined) return SERIES[mode][own]!;
  // An uncommon category borrows a slot no shown category uses.
  for (let i = SERIES[mode].length - 1; i >= 0; i--) {
    if (!taken.has(i)) {
      taken.add(i);
      return SERIES[mode][i]!;
    }
  }
  return OTHER[mode];
}

export function categoryLabel(t: ReturnType<typeof useKassaT>, category: string): string {
  return t(`common:category.${category}`, { defaultValue: category.replace(/_/g, " ") });
}

/** The emoji of a category in a soft circle: the leading mark of purchase rows. */
export function CategoryAvatar({
  category,
  size = 40,
}: {
  category: string | null;
  size?: number;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.muted,
      }}
    >
      <Text style={{ fontSize: size * 0.48, lineHeight: size * 0.62 }}>
        {categoryEmoji(category ?? "other")}
      </Text>
    </View>
  );
}

type Day = SpendingInsightsResponse["daily"][number];

/**
 * One bar per day of the month so far, baseline-anchored, today in the accent colour. Tapping a bar names the day
 * and the amount above the chart (the chart's tooltip); by default that line names the biggest day.
 */
export function DailyBars({
  days,
  currency,
  height = 96,
}: {
  days: readonly Day[];
  currency: string;
  height?: number;
}) {
  const t = useKassaT();
  const f = useFormat();
  const { colors } = useTheme();
  const [selected, setSelected] = useState<string | null>(null);
  const max = Math.max(1, ...days.map((d) => d.spentMinor));
  const peak = days.reduce<Day | null>((a, d) => (!a || d.spentMinor > a.spentMinor ? d : a), null);
  const pick = days.find((d) => d.date === selected);
  const last = days[days.length - 1]?.date;
  const gap = days.length > 20 ? 2 : 4;

  return (
    <Box gap={2}>
      <Text variant="caption" testID="daily-caption">
        {pick
          ? t("insights:daily.selected", {
              date: f.dayMonth(pick.date),
              amount: f.money(pick.spentMinor, currency),
            })
          : peak && peak.spentMinor > 0
            ? t("insights:daily.peak", {
                date: f.dayMonth(peak.date),
                amount: f.money(peak.spentMinor, currency),
              })
            : t("insights:daily.caption")}
      </Text>
      <View style={{ height, flexDirection: "row", alignItems: "flex-end", gap }}>
        {days.map((d) => {
          const h = d.spentMinor > 0 ? Math.max(4, Math.round((d.spentMinor / max) * height)) : 2;
          const active = d.date === selected || (!selected && d.date === last);
          return (
            <Pressable
              key={d.date}
              onPress={() => setSelected((s) => (s === d.date ? null : d.date))}
              accessibilityRole="button"
              accessibilityLabel={t("insights:daily.a11y", {
                date: f.dayMonth(d.date),
                amount: f.money(d.spentMinor, currency),
              })}
              hitSlop={{ top: height, bottom: 8 }}
              style={{ flex: 1, height, justifyContent: "flex-end" }}
            >
              <View
                style={{
                  height: h,
                  borderTopLeftRadius: 4,
                  borderTopRightRadius: 4,
                  backgroundColor: active ? colors.brandAccent : colors.mutedForeground,
                  opacity: active ? 1 : d.spentMinor > 0 ? 0.45 : 0.2,
                }}
              />
            </Pressable>
          );
        })}
      </View>
      <Box row justify="between">
        <Text variant="caption">{days[0] ? f.dayMonth(days[0].date) : ""}</Text>
        <Text variant="caption">{last ? f.dayMonth(last) : ""}</Text>
      </Box>
    </Box>
  );
}

interface Slice {
  key: string;
  label: string;
  spentMinor: number;
  pct: number;
  color: string;
  category: CategoryInsight | null;
}

/** The top categories by name plus "Everything else", each with its colour. */
export function categorySlices(
  categories: readonly CategoryInsight[],
  t: ReturnType<typeof useKassaT>,
  mode: ResolvedMode
): Slice[] {
  const spent = categories.filter((c) => c.spentMinor > 0);
  const shown = spent.slice(0, SHOWN_CATEGORIES);
  const rest = spent.slice(SHOWN_CATEGORIES);
  const taken = new Set(shown.map((c) => SLOT[c.category]).filter((s) => s !== undefined));
  const slices: Slice[] = shown.map((c) => ({
    key: c.category,
    label: categoryLabel(t, c.category),
    spentMinor: c.spentMinor,
    pct: c.sharePct,
    color: categoryColor(c.category, mode, taken),
    category: c,
  }));
  if (rest.length > 0) {
    slices.push({
      key: "__other",
      label: t("insights:categories.other"),
      spentMinor: rest.reduce((a, c) => a + c.spentMinor, 0),
      pct: rest.reduce((a, c) => a + c.sharePct, 0),
      color: OTHER[mode],
      category: null,
    });
  }
  return slices;
}

/** A single 100 % bar split by category (2 px gaps between segments). */
export function ShareBar({ slices, height = 12 }: { slices: readonly Slice[]; height?: number }) {
  const total = slices.reduce((a, s) => a + s.spentMinor, 0);
  if (total <= 0) return null;
  return (
    <View
      style={{ flexDirection: "row", height, gap: 2, borderRadius: 4, overflow: "hidden" }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {slices.map((s) => (
        <View key={s.key} style={{ flex: s.spentMinor / total, backgroundColor: s.color }} />
      ))}
    </View>
  );
}

/** A colour dot: the legend mark next to a category name. */
export function Swatch({ color }: { color: string }) {
  return <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />;
}
