import type { CardDto, RecentCapture, RecentCapturesResponse } from "@kassa/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable } from "react-native";

import { useSpendingInsights } from "@/api/hooks/insights";
import { useCards } from "@/api/hooks/money";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { CategoryAvatar, categoryLabel } from "@/components/kassa/spend-charts";
import { Segmented } from "@/components/kassa/segmented";
import { RowGroup } from "@/components/row-group";
import { Box, Icon, Row, Text, useTheme } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";
import { RANGE_LIMIT, useActivityRange, type ActivityRange } from "@/lite/activity-range";
import { useDataMode, visibleCaptures } from "@/lite/data-mode";
import { useRecentCaptures } from "@/lite/use-recent-captures";
import { openInsights } from "@/screens/insights/insights-screen";
import { purchaseHref } from "@/screens/transaction/transaction-detail-screen";

/** Newest purchase first (the server order is not relied on). */
export function sortCaptures(captures: readonly RecentCapture[]): RecentCapture[] {
  return [...captures].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}

/** Local calendar day of an instant ("2026-10-27"), the key purchases are grouped by. */
function localDay(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Purchases grouped by local day, newest day first, each day newest first. */
export function groupByDay(
  captures: readonly RecentCapture[]
): { day: string; captures: RecentCapture[] }[] {
  const groups: { day: string; captures: RecentCapture[] }[] = [];
  for (const c of sortCaptures(captures)) {
    const day = localDay(c.occurredAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.captures.push(c);
    else groups.push({ day, captures: [c] });
  }
  return groups;
}

/** "Visa ••4242" (the digits left out when the card has none). */
export function cardName(card: Pick<CardDto, "label" | "last4">): string {
  return card.last4 ? `${card.label} ••${card.last4}` : card.label;
}

/** One purchase: category avatar, place or merchant, amount; `dated` adds the day (lists that span days). */
export function CaptureRow({
  capture,
  dated = false,
}: {
  capture: RecentCapture;
  dated?: boolean;
}) {
  const t = useKassaT();
  const f = useFormat();
  const insights = useSpendingInsights();
  const home = insights.data?.homeCurrency;
  const category = capture.category
    ? categoryLabel(t, capture.category)
    : t("lite:activity.uncategorised");
  const name = capture.place?.name ?? capture.merchant;
  const foreign =
    home !== undefined && capture.currency !== home && capture.homeAmountMinor !== null;
  return (
    <Pressable
      onPress={() => router.push(purchaseHref(capture.id))}
      accessibilityRole="button"
      accessibilityHint={t("lite:activity.openHint")}
      testID={`capture-${capture.id}`}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Box px={4} py={3} row align="center" gap={3}>
        <CategoryAvatar category={capture.category} />
        <Box gap={1} style={{ flex: 1, minWidth: 0 }}>
          <Box row align="center" gap={3}>
            <Text weight="semibold" numberOfLines={1} style={{ flex: 1 }}>
              {name}
            </Text>
            <Text weight="semibold" style={{ fontVariant: ["tabular-nums"] }}>
              {f.money(capture.amountMinor, capture.currency)}
            </Text>
          </Box>
          <Box row align="center" gap={3}>
            <Text variant="caption" numberOfLines={1} style={{ flex: 1 }}>
              {[
                dated ? f.dateTime(capture.occurredAt) : f.time(capture.occurredAt),
                category,
                capture.place?.where,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            {foreign ? (
              <Text variant="caption" style={{ fontVariant: ["tabular-nums"] }}>
                {t("lite:activity.homeAmount", { amount: f.money(capture.homeAmountMinor!, home) })}
              </Text>
            ) : null}
          </Box>
        </Box>
      </Box>
    </Pressable>
  );
}

/** What a day's purchases came to in the home currency; null when one has no converted amount yet. */
export function dayTotal(captures: readonly RecentCapture[]): number | null {
  let total = 0;
  for (const c of captures) {
    if (c.homeAmountMinor === null) return null;
    total += c.homeAmountMinor;
  }
  return total;
}

function dayTitle(day: string, t: ReturnType<typeof useKassaT>, f: ReturnType<typeof useFormat>) {
  const now = new Date();
  if (day === localDay(now.toISOString())) return t("lite:activity.today");
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (day === localDay(y.toISOString())) return t("lite:activity.yesterday");
  return f.weekdayDay(day);
}

const SPENT_KEY: Record<ActivityRange, string> = {
  week: "lite:activity.spentWeek",
  month: "lite:activity.spentMonth",
  year: "lite:activity.spentYear",
  all: "lite:activity.spentAll",
};

/** What the purchases shown came to in the home currency (ones not converted yet are left out); opens Insights. */
function RangeTotalRow({
  range,
  captures,
}: {
  range: ActivityRange;
  captures: readonly RecentCapture[];
}) {
  const t = useKassaT();
  const f = useFormat();
  const home = useSpendingInsights().data?.homeCurrency;
  if (!home) return null;
  const total = captures.reduce((sum, c) => sum + (c.homeAmountMinor ?? 0), 0);
  return (
    <RowGroup>
      <Row
        title={t(SPENT_KEY[range])}
        trailing={
          <Text weight="semibold" style={{ fontVariant: ["tabular-nums"] }}>
            {f.money(total, home)}
          </Text>
        }
        chevron
        onPress={openInsights}
        testID="activity-month"
      />
    </RowGroup>
  );
}

/** The card the list is narrowed to, with ✕ to show every card again. */
function CardFilterPill({ cardId }: { cardId: string }) {
  const t = useKassaT();
  const { colors } = useTheme();
  const card = useCards().data?.cards.find((c) => c.id === cardId);
  return (
    <Box row>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("lite:activity.clearCard")}
        onPress={() => router.setParams({ card: undefined })}
        hitSlop={8}
        testID="activity-card-filter"
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 14,
          paddingVertical: 8,
          borderRadius: 999,
          backgroundColor: colors.brandAccent,
        }}
      >
        <Icon name="creditcard.fill" fallback="credit_card" size={16} color="primaryForeground" />
        <Text weight="semibold" numberOfLines={1} style={{ color: colors.primaryForeground }}>
          {card ? cardName(card) : t("lite:activity.oneCard")}
        </Text>
        <Icon name="xmark" fallback="close" size={14} color="primaryForeground" />
      </Pressable>
    </Box>
  );
}

export function ActivityBody({
  data,
  cardId,
  range = "month",
}: {
  data: RecentCapturesResponse;
  /** Only this card's purchases (`?card=<id>`, from a Home card page). */
  cardId?: string;
  /** The range `data` was fetched for (the total row's label). */
  range?: ActivityRange;
}) {
  const t = useKassaT();
  const f = useFormat();
  const insights = useSpendingInsights();
  const mode = useDataMode();
  const visible = visibleCaptures(data.captures, mode);
  const shown = cardId ? visible.filter((c) => c.cardId === cardId) : visible;
  const hidden = data.captures.length - visible.length;
  const groups = groupByDay(shown);
  const home = insights.data?.homeCurrency;
  return (
    <>
      {cardId ? (
        <CardFilterPill cardId={cardId} />
      ) : (
        <RangeTotalRow range={range} captures={shown} />
      )}
      {groups.length === 0 ? (
        <RowGroup title={t("lite:activity.capturesTitle")}>
          <Box p={6} gap={2} align="center">
            <Icon name="wave.3.right" fallback="contactless" size={32} color="mutedForeground" />
            <Text weight="semibold" align="center">
              {cardId
                ? t("lite:activity.cardEmpty")
                : data.captures.length === 0 && range !== "all"
                  ? t("lite:activity.rangeEmpty")
                  : t("lite:activity.empty")}
            </Text>
            {cardId ? null : (
              <Text variant="caption" align="center">
                {t("lite:activity.emptyBody")}
              </Text>
            )}
          </Box>
        </RowGroup>
      ) : null}
      {groups.map((g) => {
        const total = dayTotal(g.captures);
        return (
          <RowGroup
            key={g.day}
            icons
            title={
              total !== null && home
                ? t("lite:activity.dayTotal", {
                    day: dayTitle(g.day, t, f),
                    amount: f.money(total, home),
                  })
                : dayTitle(g.day, t, f)
            }
          >
            {g.captures.map((c) => (
              <CaptureRow key={c.id} capture={c} />
            ))}
          </RowGroup>
        );
      })}
      {data.captures.length >= RANGE_LIMIT ? (
        <Box px={4}>
          <Text variant="caption" align="center">
            {t("lite:activity.rangeCapped", { count: RANGE_LIMIT })}
          </Text>
        </Box>
      ) : null}
      {hidden > 0 ? (
        <Box px={4} testID="simulated-hidden">
          <Text variant="caption" align="center">
            {t("lite:activity.simulatedHidden", { count: hidden })}
          </Text>
        </Box>
      ) : null}
    </>
  );
}

/**
 * Activity tab: purchases the Apple Pay Shortcut captured (GET /capture/recent), polled while visible. Real mode
 * (Settings → Data shown, the default) leaves out simulated and demo-seed purchases. `?card=<id>` narrows the list to
 * one card.
 */
export function ActivityScreen() {
  const t = useKassaT();
  const { card } = useLocalSearchParams<{ card?: string }>();
  const [range, setRange] = useState<ActivityRange>("month");
  // The newest purchases, polled: new-purchase banners come from this (lite/notifier) whatever range is picked.
  useRecentCaptures();
  const list = useActivityRange(range);
  const insights = useSpendingInsights();
  const cards = useCards();
  return (
    <ScrollScreen
      onRefresh={() => Promise.all([list.refetch(), insights.refetch(), cards.refetch()])}
    >
      <Segmented
        value={range}
        onChange={setRange}
        options={[
          { value: "week", label: t("lite:activity.rangeWeek") },
          { value: "month", label: t("lite:activity.rangeMonth") },
          { value: "year", label: t("lite:activity.rangeYear") },
          { value: "all", label: t("lite:activity.rangeAll") },
        ]}
      />
      <QueryView query={list} skeletonRows={4}>
        {(data) => <ActivityBody data={data} cardId={card || undefined} range={range} />}
      </QueryView>
    </ScrollScreen>
  );
}
