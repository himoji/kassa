import type { TransactionDetailResponse } from "@kassa/shared";
import { router, useLocalSearchParams, type Href } from "expo-router";
import { useState } from "react";
import { Linking, Platform, Pressable, ScrollView, View } from "react-native";

import { useTransactionDetail } from "@/api/hooks/insights";
import { useSetCategory } from "@/api/hooks/money";
import { errorText } from "@/components/kassa/error-text";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { CategoryAvatar, categoryLabel } from "@/components/kassa/spend-charts";
import { StatusChip } from "@/components/kassa/status-chip";
import { RowGroup } from "@/components/row-group";
import { Box, Row, Text, toast, useTheme } from "@/components/ui";
import { BUDGET_CATEGORIES } from "@/lib/categories";
import { categoryEmoji } from "@/lib/category-emoji";
import { copyToClipboard } from "@/lib/clipboard";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";
import { shareText } from "@/lib/share";
import { HeaderButtons } from "@/navigation/header-buttons";
import { statusColor } from "@/theme/status";

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** Where a purchase opens (deep links: `kassa://purchase/<id>`, `kassalite://purchase/<id>`). */
export function purchaseHref(id: string): Href {
  return `/purchase/${encodeURIComponent(id)}` as Href;
}

/** Apple Maps on iOS, a maps search elsewhere; the place name as the pin's label. */
export function mapsUrl(lat: number, lon: number, label: string): string {
  const q = encodeURIComponent(label);
  return Platform.OS === "ios"
    ? `https://maps.apple.com/?ll=${lat},${lon}&q=${q}`
    : `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

function Hero({ d }: { d: TransactionDetailResponse }) {
  const t = useKassaT();
  const f = useFormat();
  const tx = d.transaction;
  const foreign = tx.currency !== d.homeCurrency && tx.homeAmountMinor !== null;
  return (
    <Box align="center" gap={2} pt={2}>
      <CategoryAvatar category={tx.category} size={64} />
      <Text variant="heading" align="center" numberOfLines={2} testID="purchase-merchant">
        {d.merchant}
      </Text>
      <Text
        variant="title"
        align="center"
        style={{ fontSize: 40, lineHeight: 46, fontVariant: ["tabular-nums"] }}
        testID="purchase-amount"
      >
        {f.money(tx.amountMinor, tx.currency)}
      </Text>
      {foreign ? (
        <Text variant="caption">
          {t("common:approxHome", { amount: f.money(tx.homeAmountMinor!, d.homeCurrency) })}
        </Text>
      ) : null}
      {/* Settled is the normal case and needs no badge; a pending one may still change. */}
      {tx.status !== "SETTLED" ? (
        <StatusChip tone="neutral" label={t(`activity:txStatus.${tx.status}`)} />
      ) : null}
    </Box>
  );
}

function Details({ d }: { d: TransactionDetailResponse }) {
  const t = useKassaT();
  const f = useFormat();
  const tx = d.transaction;
  const p = d.place;
  const statementDiffers = tx.merchantRaw.trim().toLowerCase() !== d.merchant.trim().toLowerCase();
  const value = (text: string) => (
    <Text variant="caption" numberOfLines={2} style={{ flexShrink: 1, textAlign: "right" }}>
      {text}
    </Text>
  );
  const canMap = p?.lat !== undefined && p?.lon !== undefined;
  return (
    <RowGroup>
      <Row title={t("insights:detail.when")} trailing={value(f.dateTime(tx.occurredAt))} />
      {p?.where || canMap ? (
        <Row
          title={t("insights:detail.where")}
          trailing={value(p?.where ?? t("insights:detail.openMap"))}
          chevron={canMap}
          onPress={
            canMap
              ? () => void Linking.openURL(mapsUrl(p!.lat!, p!.lon!, d.merchant)).catch(() => {})
              : undefined
          }
        />
      ) : null}
      {p?.kind ? <Row title={t("insights:detail.kind")} trailing={value(p.kind)} /> : null}
      {d.card ? (
        <Row
          title={t("insights:detail.card")}
          trailing={value(t("insights:detail.cardValue", d.card))}
        />
      ) : null}
      {p?.processor ? <Row title={t("insights:detail.via")} trailing={value(p.processor)} /> : null}
      {statementDiffers ? (
        <Row title={t("insights:detail.statementName")} trailing={value(tx.merchantRaw)} />
      ) : null}
      <Row
        title={t("insights:detail.source")}
        trailing={value(t(`activity:source.${tx.source}`, { defaultValue: tx.source }))}
      />
      {tx.currency !== d.homeCurrency && tx.rateUsed !== null && tx.rateDate ? (
        <Row
          title={t("insights:detail.home", { currency: d.homeCurrency })}
          trailing={value(
            t("insights:detail.rate", {
              rate: tx.rateUsed.toPrecision(5),
              date: f.date(tx.rateDate),
            })
          )}
        />
      ) : null}
      {tx.feeHomeMinor && tx.feeHomeMinor > 0 ? (
        <Row
          title={t("insights:detail.fee")}
          trailing={value(f.money(tx.feeHomeMinor, d.homeCurrency))}
        />
      ) : null}
    </RowGroup>
  );
}

function CategoryPicker({ d }: { d: TransactionDetailResponse }) {
  const t = useKassaT();
  const { colors } = useTheme();
  const setCategory = useSetCategory();
  const [open, setOpen] = useState(false);
  const current = d.transaction.category;
  const choose = (category: string) => {
    if (category === current) return setOpen(false);
    setCategory.mutate(
      { id: d.transaction.id, category },
      {
        onSuccess: () => {
          setOpen(false);
          toast.show({
            title: t("insights:detail.categoryChanged", { merchant: d.merchant }),
            kind: "success",
          });
        },
        onError: (err) => toast.show({ title: errorText(t, err), kind: "error" }),
      }
    );
  };
  return (
    <RowGroup title={t("insights:detail.category")}>
      <Row
        leading={<Text style={{ fontSize: 20 }}>{categoryEmoji(current ?? "other")}</Text>}
        title={current ? categoryLabel(t, current) : t("insights:detail.uncategorised")}
        trailing={
          <Text style={{ color: colors.brandAccent }}>{t("insights:detail.changeCategory")}</Text>
        }
        onPress={() => setOpen((o) => !o)}
        testID="change-category"
      />
      {open ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ padding: 12, gap: 8 }}
        >
          {BUDGET_CATEGORIES.map((c) => {
            const selected = c === current;
            return (
              <Pressable
                key={c}
                onPress={() => choose(c)}
                disabled={setCategory.isPending}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                testID={`category-${c}`}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  minHeight: 36,
                  paddingHorizontal: 12,
                  borderRadius: 18,
                  borderWidth: 1,
                  borderColor: selected ? colors.brandAccent : colors.border,
                  backgroundColor: selected ? colors.muted : colors.card,
                }}
              >
                <Text>{categoryEmoji(c)}</Text>
                <Text weight={selected ? "semibold" : undefined}>{categoryLabel(t, c)}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
    </RowGroup>
  );
}

function MonthContext({ d }: { d: TransactionDetailResponse }) {
  const t = useKassaT();
  const f = useFormat();
  const { colors, mode } = useTheme();
  const c = d.category;
  if (!c) return null;
  const money = (m: number) => f.money(m, d.homeCurrency);
  const b = c.budget;
  const ratio = b && b.limitMinor > 0 ? Math.min(1, b.spentMinor / b.limitMinor) : 0;
  const tone = !b
    ? "neutral"
    : b.pace === "OVER"
      ? "critical"
      : b.pace === "AHEAD_OF_PACE"
        ? "warning"
        : "positive";
  return (
    <RowGroup title={t("insights:detail.monthTitle", { category: categoryLabel(t, c.category) })}>
      <Box p={4} gap={2}>
        <Text weight="semibold">
          {t("insights:detail.monthSpent", {
            amount: money(c.spentThisMonthMinor),
            count: c.countThisMonth,
          })}
        </Text>
        <Text variant="caption">{t("insights:detail.monthShare", { pct: c.shareOfMonthPct })}</Text>
        {c.typicalMinor !== null ? (
          <Text variant="caption">
            {t("insights:detail.monthUsual", { amount: money(c.typicalMinor) })}
          </Text>
        ) : null}
        {b ? (
          <Box gap={2} pt={1}>
            <View
              style={{
                height: 8,
                borderRadius: 4,
                backgroundColor: colors.muted,
                overflow: "hidden",
              }}
            >
              <View
                style={{
                  width: `${Math.round(ratio * 100)}%`,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: statusColor(tone, mode),
                }}
              />
            </View>
            <Box row align="center" justify="between" gap={2}>
              <Text variant="caption" style={{ flexShrink: 1 }}>
                {b.remainingMinor < 0
                  ? t("insights:detail.budgetOver", {
                      amount: money(-b.remainingMinor),
                      limit: money(b.limitMinor),
                    })
                  : t("insights:detail.budgetLeft", {
                      amount: money(b.remainingMinor),
                      limit: money(b.limitMinor),
                      days: b.daysLeft,
                    })}
              </Text>
              <StatusChip tone={tone} label={t(`home:pace.${b.pace}`)} />
            </Box>
          </Box>
        ) : (
          <Text variant="caption">{t("insights:detail.noBudget")}</Text>
        )}
      </Box>
    </RowGroup>
  );
}

function MerchantHistory({ d }: { d: TransactionDetailResponse }) {
  const t = useKassaT();
  const f = useFormat();
  const h = d.merchantHistory;
  return (
    <RowGroup title={t("insights:detail.historyTitle", { merchant: d.merchant })}>
      <Box p={4} gap={1}>
        <Text weight="semibold">
          {t("insights:detail.historyVisits", {
            count: h.visits,
            total: f.money(h.totalMinor, d.homeCurrency),
          })}
        </Text>
        {h.visits > 1 ? (
          <Text variant="caption">
            {[
              t("insights:detail.historyAverage", {
                amount: f.money(h.averageMinor, d.homeCurrency),
              }),
              t("insights:detail.historySince", { date: f.date(h.firstAt) }),
            ].join(" · ")}
          </Text>
        ) : null}
      </Box>
      {h.recent.map((r) => (
        <Row
          key={r.id}
          title={f.dateTime(r.occurredAt)}
          trailing={
            <Text style={{ fontVariant: ["tabular-nums"] }}>
              {f.money(r.amountMinor, r.currency)}
            </Text>
          }
          chevron
          onPress={() => router.push(purchaseHref(r.id))}
        />
      ))}
    </RowGroup>
  );
}

export function TransactionDetailBody({ d }: { d: TransactionDetailResponse }) {
  return (
    <>
      <Hero d={d} />
      <Details d={d} />
      <CategoryPicker d={d} />
      <MonthContext d={d} />
      <MerchantHistory d={d} />
    </>
  );
}

/** One purchase: amount, when and where, card, category (changeable), the month in that category, the merchant's history. */
export function TransactionDetailScreen() {
  const t = useKassaT();
  const f = useFormat();
  const id = first(useLocalSearchParams<{ id?: string }>().id);
  const detail = useTransactionDetail(id);
  const d = detail.data;

  const share = () => {
    if (!d) return;
    void shareText({
      message: t("insights:detail.shareText", {
        merchant: d.merchant,
        amount: f.money(d.transaction.amountMinor, d.transaction.currency),
        date: f.dateTime(d.transaction.occurredAt),
      }),
    });
  };

  return (
    <>
      {d ? (
        <HeaderButtons
          placement="right"
          buttons={[
            {
              icon: "doc.on.doc",
              fallback: "content_copy",
              label: t("insights:detail.copyId"),
              onPress: () =>
                void copyToClipboard(d.transaction.id, { toast: t("insights:detail.copied") }),
            },
            {
              icon: "square.and.arrow.up",
              fallback: "share",
              label: t("insights:detail.share"),
              onPress: share,
            },
          ]}
        />
      ) : null}
      <ScrollScreen onRefresh={() => void detail.refetch()} refreshing={detail.isRefetching}>
        <QueryView query={detail} skeletonRows={6}>
          {(data) => <TransactionDetailBody d={data} />}
        </QueryView>
      </ScrollScreen>
    </>
  );
}
