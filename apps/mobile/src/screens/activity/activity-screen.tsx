import type { LedgerEntryDto, NotificationDto, TransactionDto } from "@kassa/shared";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, View } from "react-native";

import { useLedger, useMarkNotificationRead, useNotifications } from "@/api/hooks/activity";
import { useMe } from "@/api/hooks/me";
import { useTransactions } from "@/api/hooks/money";
import { errorText } from "@/components/kassa/error-text";
import { ReasonCodeList } from "@/components/kassa/reason-codes";
import { Segmented } from "@/components/kassa/segmented";
import { StatusChip } from "@/components/kassa/status-chip";
import {
  Box,
  Divider,
  EmptyState,
  ErrorState,
  Icon,
  Skeleton,
  Text,
  useTheme,
} from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

import { ledgerDisplay } from "./ledger-entry";

type Segment = "timeline" | "spending" | "inbox";

function LedgerRow({ entry }: { entry: LedgerEntryDto }) {
  const t = useKassaT();
  const f = useFormat();
  const d = ledgerDisplay(entry);
  const title = t(`activity:type.${entry.type}`, { defaultValue: t("activity:type.OTHER") });
  const open = d.paymentId && entry.type.startsWith("HANDOFF") ? `/handoff/${d.paymentId}` : null;
  const body = (
    <View style={{ paddingVertical: 12, gap: 6, minHeight: 44 }}>
      <Box row justify="between" gap={3}>
        <Box row gap={2} align="center" style={{ flexShrink: 1 }}>
          <Icon
            name={d.refused ? "xmark.octagon" : "checkmark.circle"}
            fallback={d.refused ? "block" : "check_circle"}
            size={18}
            color={d.refused ? "destructive" : "mutedForeground"}
          />
          <Text weight="semibold" numberOfLines={2} style={{ flexShrink: 1 }}>
            {title}
          </Text>
        </Box>
        {d.amount ? (
          <Text style={{ fontVariant: ["tabular-nums"] }}>
            {f.money(d.amount.amountMinor, d.amount.currency)}
          </Text>
        ) : null}
      </Box>
      {d.counterparty ? <Text variant="caption">{d.counterparty}</Text> : null}
      {d.decision ? (
        <StatusChip
          tone={d.decision === "REFUSE" ? "critical" : d.decision === "AUTO" ? "positive" : "info"}
          label={t(`common:decision.${d.decision}`)}
        />
      ) : null}
      <ReasonCodeList codes={d.reasonCodes} />
      <Text variant="caption" selectable>
        {t("activity:entryMeta", {
          time: f.dateTime(entry.ts),
          seq: entry.seq,
          hash: entry.hash.slice(0, 8),
        })}
      </Text>
    </View>
  );
  return open ? (
    <Pressable accessibilityRole="link" onPress={() => router.push(open as `/handoff/${string}`)}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

function TransactionRow({ tx }: { tx: TransactionDto }) {
  const t = useKassaT();
  const f = useFormat();
  const homeCurrency = useMe().data?.homeCurrency;
  return (
    <View style={{ paddingVertical: 12, gap: 4, minHeight: 44 }}>
      <Box row justify="between" gap={3}>
        <Text weight="semibold" numberOfLines={1} style={{ flexShrink: 1 }}>
          {tx.merchantRaw}
        </Text>
        <Text style={{ fontVariant: ["tabular-nums"] }}>
          {f.money(tx.amountMinor, tx.currency)}
        </Text>
      </Box>
      <Text variant="caption">
        {t("activity:txMeta", {
          time: f.dateTime(tx.occurredAt),
          category: tx.category
            ? t(`common:category.${tx.category}`, { defaultValue: tx.category })
            : t("activity:uncategorised"),
          source: t(`activity:source.${tx.source}`),
        })}
      </Text>
      <Box row gap={2} style={{ flexWrap: "wrap" }}>
        <StatusChip
          tone={tx.status === "SETTLED" ? "positive" : "neutral"}
          label={t(`activity:txStatus.${tx.status}`)}
        />
        {tx.feeHomeMinor && tx.feeHomeMinor > 0 && homeCurrency ? (
          <StatusChip
            tone="warning"
            label={t("activity:hiddenFee", { amount: f.money(tx.feeHomeMinor, homeCurrency) })}
          />
        ) : null}
      </Box>
    </View>
  );
}

function NotificationRow({ n }: { n: NotificationDto }) {
  const t = useKassaT();
  const f = useFormat();
  const markRead = useMarkNotificationRead();
  const unread = n.readAt === null;
  return (
    <Pressable
      onPress={() => unread && markRead.mutate(n.id)}
      accessibilityRole="button"
      accessibilityLabel={unread ? t("activity:unreadA11y", { title: n.title }) : n.title}
      style={{ paddingVertical: 12, gap: 4, minHeight: 44 }}
    >
      <Box row gap={2} align="center">
        {unread ? <StatusChip tone="info" label={t("activity:new")} /> : null}
        <Text weight={unread ? "semibold" : undefined} style={{ flexShrink: 1 }}>
          {n.title}
        </Text>
      </Box>
      <Text variant="caption">{n.body}</Text>
      <Text variant="caption">{f.dateTime(n.createdAt)}</Text>
    </Pressable>
  );
}

function ListState({
  pending,
  error,
  retry,
}: {
  pending: boolean;
  error: unknown;
  retry: () => void;
}) {
  const t = useKassaT();
  if (pending) {
    return (
      <Box gap={3}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} h={56} radius="md" />
        ))}
      </Box>
    );
  }
  if (error) {
    return (
      <ErrorState
        title={t("common:errors.loadTitle")}
        description={errorText(t, error)}
        retry={retry}
      />
    );
  }
  return null;
}

export function ActivityScreen() {
  const t = useKassaT();
  const { colors } = useTheme();
  const [segment, setSegment] = useState<Segment>("timeline");
  const ledger = useLedger();
  const txs = useTransactions();
  const notes = useNotifications();

  const header = (
    <Box gap={4} pb={2}>
      <Segmented<Segment>
        value={segment}
        onChange={setSegment}
        options={[
          { value: "timeline", label: t("activity:segment.timeline") },
          { value: "spending", label: t("activity:segment.spending") },
          { value: "inbox", label: t("activity:segment.inbox") },
        ]}
      />
      {segment === "timeline" ? <Text variant="caption">{t("activity:timelineHint")}</Text> : null}
    </Box>
  );

  const common = {
    contentInsetAdjustmentBehavior: "automatic" as const,
    style: { flex: 1, backgroundColor: colors.background },
    contentContainerStyle: { padding: 16, paddingBottom: 48 },
    ItemSeparatorComponent: () => <Divider spacing={0} />,
    ListHeaderComponent: header,
  };

  if (segment === "timeline") {
    const items = ledger.data?.pages.flatMap((p) => p.items) ?? [];
    return (
      <FlatList
        {...common}
        data={items}
        keyExtractor={(e) => String(e.seq)}
        renderItem={({ item }) => <LedgerRow entry={item} />}
        onEndReached={() =>
          ledger.hasNextPage && !ledger.isFetchingNextPage && void ledger.fetchNextPage()
        }
        refreshing={ledger.isRefetching}
        onRefresh={() => void ledger.refetch()}
        ListEmptyComponent={
          ledger.isPending || ledger.error ? (
            <ListState
              pending={ledger.isPending}
              error={ledger.error}
              retry={() => void ledger.refetch()}
            />
          ) : (
            <EmptyState title={t("activity:emptyTimeline")} />
          )
        }
        ListFooterComponent={ledger.isFetchingNextPage ? <ActivityIndicator /> : null}
      />
    );
  }
  if (segment === "spending") {
    const items =
      txs.data?.pages.flatMap((p) => p.items).filter((x) => x.mergedIntoId === null) ?? [];
    return (
      <FlatList
        {...common}
        data={items}
        keyExtractor={(x) => x.id}
        renderItem={({ item }) => <TransactionRow tx={item} />}
        onEndReached={() => txs.hasNextPage && !txs.isFetchingNextPage && void txs.fetchNextPage()}
        refreshing={txs.isRefetching}
        onRefresh={() => void txs.refetch()}
        ListEmptyComponent={
          txs.isPending || txs.error ? (
            <ListState pending={txs.isPending} error={txs.error} retry={() => void txs.refetch()} />
          ) : (
            <EmptyState title={t("activity:emptySpending")} />
          )
        }
        ListFooterComponent={txs.isFetchingNextPage ? <ActivityIndicator /> : null}
      />
    );
  }
  const list = notes.data?.notifications ?? [];
  return (
    <FlatList
      {...common}
      data={list}
      keyExtractor={(n) => n.id}
      renderItem={({ item }) => <NotificationRow n={item} />}
      refreshing={notes.isRefetching}
      onRefresh={() => void notes.refetch()}
      ListEmptyComponent={
        notes.isPending || notes.error ? (
          <ListState
            pending={notes.isPending}
            error={notes.error}
            retry={() => void notes.refetch()}
          />
        ) : (
          <EmptyState title={t("activity:emptyInbox")} />
        )
      }
    />
  );
}
