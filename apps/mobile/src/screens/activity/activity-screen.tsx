import {
  ReasonCode,
  type LedgerEntryDto,
  type NotificationDto,
  type TransactionDto,
} from "@kassa/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { FlatList, Platform, Pressable, View } from "react-native";

import { useLedger, useMarkNotificationRead, useNotifications } from "@/api/hooks/activity";
import { useMe } from "@/api/hooks/me";
import { useShopOrders } from "@/api/hooks/shop";
import { useSpendingInsights } from "@/api/hooks/insights";
import { useCards, useTransactions } from "@/api/hooks/money";
import { errorText } from "@/components/kassa/error-text";
import { usePullRefresh } from "@/components/kassa/scroll-screen";
import { ReasonCodeList } from "@/components/kassa/reason-codes";
import { Segmented } from "@/components/kassa/segmented";
import { CategoryAvatar } from "@/components/kassa/spend-charts";
import { StatusChip } from "@/components/kassa/status-chip";
import {
  Box,
  Button,
  Divider,
  EmptyState,
  ErrorState,
  Icon,
  Skeleton,
  Spinner,
  Text,
  useTheme,
} from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";
import { MonthSummaryCard, openInsights } from "@/screens/insights/insights-screen";
import { cardName } from "@/screens/lite/activity-screen";
import { purchaseHref } from "@/screens/transaction/transaction-detail-screen";

import { ShopOrderTimeline } from "../shop/shop-order-timeline";
import { ledgerDisplay } from "./ledger-entry";
import { notificationReasonCodes, notificationText } from "./notification-text";

type Segment = "spending" | "orders" | "inbox" | "log";

/**
 * One audit-log entry, calm by default: title and amount, then the time. Refused or blocked entries carry one
 * small chip. Tapping the row shows the rest inline: who it was with, the decision, the reasons in plain language and
 * the event number and hash.
 */
export function LedgerRow({ entry }: { entry: LedgerEntryDto }) {
  const t = useKassaT();
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const d = ledgerDisplay(entry);
  const title = t(`activity:type.${entry.type}`, { defaultValue: t("activity:type.OTHER") });
  const handoff = d.paymentId && entry.type.startsWith("HANDOFF") ? d.paymentId : null;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityHint={t("activity:detailsHint")}
        onPress={() => setOpen((o) => !o)}
        testID={`ledger-${entry.seq}`}
        style={({ pressed }) => ({
          paddingVertical: 12,
          gap: 4,
          minHeight: 44,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Box row justify="between" align="center" gap={3}>
          <Text weight="semibold" numberOfLines={1} style={{ flexShrink: 1 }}>
            {title}
          </Text>
          {d.amount ? (
            <Text style={{ fontVariant: ["tabular-nums"] }}>
              {f.money(d.amount.amountMinor, d.amount.currency)}
            </Text>
          ) : null}
        </Box>
        <Box row align="center" gap={2}>
          <Text variant="caption">{f.dateTime(entry.ts)}</Text>
          {d.refused ? (
            <StatusChip
              tone="critical"
              label={t("common:decision.REFUSE")}
              testID={`ledger-refused-${entry.seq}`}
            />
          ) : null}
        </Box>
      </Pressable>
      {open ? (
        <Box gap={2} pb={3} testID={`ledger-details-${entry.seq}`}>
          {d.counterparty ? <Text variant="caption">{d.counterparty}</Text> : null}
          {d.decision ? (
            <StatusChip
              tone={
                d.decision === "REFUSE" ? "critical" : d.decision === "AUTO" ? "positive" : "info"
              }
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
          {handoff ? (
            <Button
              size="sm"
              variant="secondary"
              style={{ alignSelf: "flex-start" }}
              onPress={() => router.push(`/handoff/${handoff}`)}
            >
              {t("activity:openHandoff")}
            </Button>
          ) : null}
        </Box>
      ) : null}
    </View>
  );
}

/** One purchase: category, merchant and amount; status and source are on the purchase screen. */
function TransactionRow({ tx }: { tx: TransactionDto }) {
  const t = useKassaT();
  const f = useFormat();
  const homeCurrency = useMe().data?.homeCurrency;
  const meta = t("activity:txMetaShort", {
    time: f.dateTime(tx.occurredAt),
    category: tx.category
      ? t(`common:category.${tx.category}`, { defaultValue: tx.category })
      : t("activity:uncategorised"),
  });
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => router.push(purchaseHref(tx.id))}
      style={({ pressed }) => ({
        paddingVertical: 12,
        minHeight: 44,
        opacity: pressed ? 0.6 : 1,
      })}
      testID={`tx-${tx.id}`}
    >
      <Box row align="center" gap={3}>
        <CategoryAvatar category={tx.category} size={36} />
        <Box gap={1} style={{ flex: 1, minWidth: 0 }}>
          <Box row justify="between" gap={3}>
            <Text weight="semibold" numberOfLines={1} style={{ flexShrink: 1 }}>
              {tx.merchantRaw}
            </Text>
            <Text style={{ fontVariant: ["tabular-nums"] }}>
              {f.money(tx.amountMinor, tx.currency)}
            </Text>
          </Box>
          <Text variant="caption" numberOfLines={1}>
            {tx.status === "PENDING" ? `${meta} · ${t("activity:txStatus.PENDING")}` : meta}
          </Text>
          {tx.feeHomeMinor && tx.feeHomeMinor > 0 && homeCurrency ? (
            <StatusChip
              tone="warning"
              label={t("activity:hiddenFee", { amount: f.money(tx.feeHomeMinor, homeCurrency) })}
            />
          ) : null}
        </Box>
      </Box>
    </Pressable>
  );
}

/** The card Spending is narrowed to (`?card=<id>`), with ✕ to show every card again. */
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

function NotificationRow({ n }: { n: NotificationDto }) {
  const t = useKassaT();
  const f = useFormat();
  const markRead = useMarkNotificationRead();
  const unread = n.readAt === null;
  // {key, params} notifications through i18n (English fallback = the server's text); reason codes in plain
  // language next to the text (Y6).
  const text = notificationText(n, t, f.money);
  const codes = notificationReasonCodes(n).flatMap((c) => {
    const r = ReasonCode.safeParse(c);
    return r.success ? [r.data] : [];
  });
  const txId = typeof n.data?.transactionId === "string" ? n.data.transactionId : null;
  return (
    <Pressable
      onPress={() => {
        if (unread) markRead.mutate(n.id);
        if (txId) router.push(purchaseHref(txId));
      }}
      accessibilityRole="button"
      accessibilityLabel={unread ? t("activity:unreadA11y", { title: text.title }) : text.title}
      style={{ paddingVertical: 12, gap: 4, minHeight: 44 }}
    >
      <Box row gap={2} align="center">
        {unread ? <StatusChip tone="info" label={t("activity:new")} /> : null}
        <Text weight={unread ? "semibold" : undefined} style={{ flexShrink: 1 }}>
          {text.title}
        </Text>
      </Box>
      <Text variant="caption">{text.body}</Text>
      {codes.length > 0 ? <ReasonCodeList codes={codes} /> : null}
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

/** Web on a wide window: the list keeps ScrollScreen's readable column. */
const WEB_COLUMN =
  Platform.OS === "web"
    ? ({ width: "100%", maxWidth: 760, alignSelf: "center", paddingTop: 24 } as const)
    : null;

/**
 * Activity: purchases first (Spending), then shop orders, the inbox and, last, the audit log. `?card=<id>` (a Home
 * card page) opens Spending narrowed to that card.
 */
export function ActivityScreen() {
  const t = useKassaT();
  const { colors } = useTheme();
  const { card: cardParam } = useLocalSearchParams<{ card?: string }>();
  const cardId = cardParam || undefined;
  const [segment, setSegment] = useState<Segment>("spending");
  // The tab stays mounted: a card link arriving later still lands on Spending (adjusted during render).
  const [seenCard, setSeenCard] = useState(cardId);
  if (cardId !== seenCard) {
    setSeenCard(cardId);
    if (cardId) setSegment("spending");
  }
  const ledger = useLedger();
  const txs = useTransactions();
  const notes = useNotifications();
  const insights = useSpendingInsights();
  // (M2/M3) Polls every 2 s while an order is open (see useShopOrders); only while this segment is shown.
  const shop = useShopOrders({ enabled: segment === "orders" });
  // Spinner only for a user pull, not for background refetches/polls.
  const pull = usePullRefresh(() =>
    (segment === "log"
      ? ledger
      : segment === "spending"
        ? txs
        : segment === "orders"
          ? shop
          : notes
    ).refetch()
  );

  const spending =
    txs.data?.pages
      .flatMap((p) => p.items)
      .filter((x) => x.mergedIntoId === null && (!cardId || x.cardId === cardId)) ?? [];
  // The server has no card filter: while a card shows nothing yet, keep loading older pages.
  const needMore =
    segment === "spending" &&
    cardId !== undefined &&
    spending.length === 0 &&
    txs.hasNextPage &&
    !txs.isFetchingNextPage;
  useEffect(() => {
    if (needMore) void txs.fetchNextPage();
  }, [needMore, txs]);

  const header = (
    <Box gap={4} pb={2}>
      <Segmented<Segment>
        value={segment}
        onChange={setSegment}
        options={[
          { value: "spending", label: t("activity:segment.spending") },
          { value: "orders", label: t("shop:segment") },
          { value: "inbox", label: t("activity:segment.inbox") },
          { value: "log", label: t("activity:segment.log") },
        ]}
      />
      {segment === "log" ? <Text variant="caption">{t("activity:timelineHint")}</Text> : null}
      {segment === "spending" && cardId ? <CardFilterPill cardId={cardId} /> : null}
      {segment === "spending" && !cardId && insights.data ? (
        <MonthSummaryCard data={insights.data} onPress={openInsights} />
      ) : null}
    </Box>
  );

  const common = {
    contentInsetAdjustmentBehavior: "automatic" as const,
    style: { flex: 1, backgroundColor: colors.background },
    contentContainerStyle: [{ padding: 16, paddingBottom: 48 }, WEB_COLUMN],
    ItemSeparatorComponent: () => <Divider spacing={0} />,
    ListHeaderComponent: header,
  };

  if (segment === "log") {
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
        refreshing={pull.refreshing}
        onRefresh={pull.onRefresh}
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
        ListFooterComponent={ledger.isFetchingNextPage ? <Spinner /> : null}
      />
    );
  }
  if (segment === "spending") {
    return (
      <FlatList
        {...common}
        data={spending}
        keyExtractor={(x) => x.id}
        renderItem={({ item }) => <TransactionRow tx={item} />}
        onEndReached={() => txs.hasNextPage && !txs.isFetchingNextPage && void txs.fetchNextPage()}
        refreshing={pull.refreshing}
        onRefresh={pull.onRefresh}
        ListEmptyComponent={
          txs.isPending || txs.error ? (
            <ListState pending={txs.isPending} error={txs.error} retry={() => void txs.refetch()} />
          ) : needMore || txs.isFetchingNextPage ? null : (
            <EmptyState
              title={cardId ? t("lite:activity.cardEmpty") : t("activity:emptySpending")}
            />
          )
        }
        ListFooterComponent={txs.isFetchingNextPage ? <Spinner /> : null}
      />
    );
  }
  if (segment === "orders") {
    const orders = shop.data?.shopOrders ?? [];
    return (
      <FlatList
        {...common}
        data={orders}
        keyExtractor={(o) => o.id}
        renderItem={({ item }) =>
          item.proposalId ? (
            <Pressable
              accessibilityRole="link"
              onPress={() => router.push(`/order/${item.proposalId}`)}
              style={{ paddingVertical: 8 }}
            >
              <ShopOrderTimeline order={item} />
            </Pressable>
          ) : (
            <View style={{ paddingVertical: 8 }}>
              <ShopOrderTimeline order={item} />
            </View>
          )
        }
        refreshing={pull.refreshing}
        onRefresh={pull.onRefresh}
        ListEmptyComponent={
          shop.isPending || shop.error ? (
            <ListState
              pending={shop.isPending}
              error={shop.error}
              retry={() => void shop.refetch()}
            />
          ) : (
            <EmptyState title={t("shop:emptyOrders")} />
          )
        }
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
      refreshing={pull.refreshing}
      onRefresh={pull.onRefresh}
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
