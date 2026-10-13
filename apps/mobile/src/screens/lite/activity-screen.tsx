import type { RecentCapture, RecentCapturesResponse } from "@kassa/shared";

import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { RowGroup } from "@/components/row-group";
import { Box, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";
import { useRecentCaptures } from "@/lite/use-recent-captures";

/** Newest purchase first (the server order is not relied on). */
export function sortCaptures(captures: readonly RecentCapture[]): RecentCapture[] {
  return [...captures].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}

function CaptureRow({ capture }: { capture: RecentCapture }) {
  const t = useKassaT();
  const f = useFormat();
  return (
    <Box p={4} row justify="between" align="center" gap={3} testID={`capture-${capture.id}`}>
      <Box gap={1} style={{ flexShrink: 1 }}>
        <Text weight="semibold" numberOfLines={1}>
          {capture.merchant}
        </Text>
        <Text variant="caption">
          {capture.category ?? t("lite:activity.uncategorised")} · {f.dateTime(capture.occurredAt)}
        </Text>
      </Box>
      <Text weight="semibold">{f.money(capture.amountMinor, capture.currency)}</Text>
    </Box>
  );
}

export function ActivityBody({ data }: { data: RecentCapturesResponse }) {
  const t = useKassaT();
  const f = useFormat();
  const captures = sortCaptures(data.captures);
  return (
    <>
      {data.nudges.length > 0 ? (
        <RowGroup title={t("lite:activity.nudgesTitle")}>
          {data.nudges.map((n) => (
            <Box key={n.id} p={4} gap={1}>
              <Text weight="semibold">{n.title}</Text>
              <Text variant="caption">{n.body}</Text>
            </Box>
          ))}
        </RowGroup>
      ) : null}
      <RowGroup
        title={t("lite:activity.capturesTitle")}
        footer={t("lite:activity.updated", { time: f.dateTime(data.serverTime) })}
      >
        {captures.length === 0 ? (
          <Box p={4} gap={1}>
            <Text weight="semibold">{t("lite:activity.empty")}</Text>
            <Text variant="caption">{t("lite:activity.emptyBody")}</Text>
          </Box>
        ) : null}
        {captures.map((c) => (
          <CaptureRow key={c.id} capture={c} />
        ))}
      </RowGroup>
    </>
  );
}

/** Activity tab: purchases the Apple Pay Shortcut captured (GET /capture/recent), polled while visible. */
export function ActivityScreen() {
  const recent = useRecentCaptures();
  return (
    <ScrollScreen onRefresh={() => void recent.refetch()} refreshing={recent.isRefetching}>
      <QueryView query={recent} skeletonRows={4}>
        {(data) => <ActivityBody data={data} />}
      </QueryView>
    </ScrollScreen>
  );
}
