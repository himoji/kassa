import type { RecentCapture, RecentCapturesResponse } from "@kassa/shared";
import { router } from "expo-router";
import { Pressable } from "react-native";

import { useSpendingInsights } from "@/api/hooks/insights";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { CategoryAvatar, categoryLabel } from "@/components/kassa/spend-charts";
import { RowGroup } from "@/components/row-group";
import { Box, Icon, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";
import { useRecentCaptures } from "@/lite/use-recent-captures";
import { MonthSummaryCard, openInsights } from "@/screens/insights/insights-screen";
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

function CaptureRow({ capture }: { capture: RecentCapture }) {
  const t = useKassaT();
  const f = useFormat();
  const category = capture.category
    ? categoryLabel(t, capture.category)
    : t("lite:activity.uncategorised");
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
        <Box gap={1} style={{ flex: 1 }}>
          <Text weight="semibold" numberOfLines={1}>
            {capture.place?.name ?? capture.merchant}
          </Text>
          <Text variant="caption" numberOfLines={2}>
            {[category, f.time(capture.occurredAt), capture.place?.where]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </Box>
        <Box style={{ alignItems: "flex-end" }} gap={1}>
          <Text weight="semibold" style={{ fontVariant: ["tabular-nums"] }}>
            {f.money(capture.amountMinor, capture.currency)}
          </Text>
        </Box>
        <Icon name="chevron.forward" fallback="chevron_right" size={14} color="mutedForeground" />
      </Box>
    </Pressable>
  );
}

function dayTitle(day: string, t: ReturnType<typeof useKassaT>, f: ReturnType<typeof useFormat>) {
  const now = new Date();
  if (day === localDay(now.toISOString())) return t("lite:activity.today");
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (day === localDay(y.toISOString())) return t("lite:activity.yesterday");
  return f.date(day, "long");
}

export function ActivityBody({ data }: { data: RecentCapturesResponse }) {
  const t = useKassaT();
  const f = useFormat();
  const insights = useSpendingInsights();
  const groups = groupByDay(data.captures);
  return (
    <>
      {insights.data ? <MonthSummaryCard data={insights.data} onPress={openInsights} /> : null}
      {data.nudges.length > 0 ? (
        <RowGroup title={t("lite:activity.nudgesTitle")}>
          {data.nudges.slice(0, 3).map((n) => (
            <Box key={n.id} p={4} row gap={3}>
              <Icon name="sparkles" fallback="auto_awesome" size={18} color="brandAccent" />
              <Box gap={1} style={{ flex: 1 }}>
                <Text weight="semibold">{n.title}</Text>
                <Text variant="caption">{n.body}</Text>
              </Box>
            </Box>
          ))}
        </RowGroup>
      ) : null}
      {groups.length === 0 ? (
        <RowGroup title={t("lite:activity.capturesTitle")}>
          <Box p={6} gap={2} align="center">
            <Icon name="wave.3.right" fallback="contactless" size={32} color="mutedForeground" />
            <Text weight="semibold" align="center">
              {t("lite:activity.empty")}
            </Text>
            <Text variant="caption" align="center">
              {t("lite:activity.emptyBody")}
            </Text>
          </Box>
        </RowGroup>
      ) : null}
      {groups.map((g, i) => (
        <RowGroup
          key={g.day}
          icons
          title={dayTitle(g.day, t, f)}
          footer={
            i === groups.length - 1
              ? t("lite:activity.updated", { time: f.dateTime(data.serverTime) })
              : undefined
          }
        >
          {g.captures.map((c) => (
            <CaptureRow key={c.id} capture={c} />
          ))}
        </RowGroup>
      ))}
    </>
  );
}

/** Activity tab: purchases the Apple Pay Shortcut captured (GET /capture/recent), polled while visible. */
export function ActivityScreen() {
  const recent = useRecentCaptures();
  const insights = useSpendingInsights();
  return (
    <ScrollScreen
      onRefresh={() => {
        void recent.refetch();
        void insights.refetch();
      }}
      refreshing={recent.isRefetching}
    >
      <QueryView query={recent} skeletonRows={4}>
        {(data) => <ActivityBody data={data} />}
      </QueryView>
    </ScrollScreen>
  );
}
