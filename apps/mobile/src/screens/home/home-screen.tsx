import { router, Stack } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { useMoneyHistory } from "@/api/hooks/dataport";
import type { AgentOutcome } from "@kassa/shared";
import { useSpendingInsights } from "@/api/hooks/insights";
import { useMe } from "@/api/hooks/me";
import {
  useBalances,
  useBudgets,
  useCardFees,
  useObligations,
  useAgentActivity,
  usePendingProposals,
} from "@/api/hooks/money";
import { usePayees } from "@/api/hooks/payees";
import { RowGroup } from "@/components/row-group";
import { SimulatedBadge } from "@/components/kassa/badges";
import { BudgetBar, BudgetsSummary, sortBudgets } from "@/components/kassa/budget-bar";
import { FreezeButton } from "@/components/kassa/freeze-button";
import { ObligationRow } from "@/components/kassa/obligation-row";
import { ProposalCard } from "@/components/kassa/proposal-card";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { StatusChip } from "@/components/kassa/status-chip";
import { Box, Button, Card, Divider, Icon, Row, Text, useTheme } from "@/components/ui";
import { useRequireBackupCodes } from "@/hooks/use-require-backup-codes";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";
import { isLiteBuild } from "@/lite/variant";
import { MonthSummaryCard, openInsights } from "@/screens/insights/insights-screen";
import { CATEGORIES, CATEGORY_ICON } from "@/screens/payees/recipient-fields";

const UPCOMING_LIMIT = 4;

/** This month's spending at a glance; opens Insights. Hidden until it loads (the budgets below carry the page). */
function MonthSpend() {
  const insights = useSpendingInsights();
  return insights.data ? <MonthSummaryCard data={insights.data} onPress={openInsights} /> : null;
}
/** Agent actions listed on Home (the rest are in the activity timeline). */
const AGENT_ITEMS = 4;

const OUTCOME_TONE: Record<AgentOutcome, "positive" | "warning" | "critical" | "info" | "neutral"> =
  {
    PAID_AUTO: "positive",
    PAID_APPROVED: "positive",
    WAITING: "info",
    HELD: "warning",
    DECLINED: "neutral",
    OTHER: "neutral",
  };

/**
 * What Kassa did this week (GET /agent/activity): payments it made inside a signed mandate, orders waiting for the
 * passkey, and orders the rules held, each with why. The AI's work made visible on the first screen.
 */
function AgentActivityCard() {
  const t = useKassaT();
  const f = useFormat();
  const activity = useAgentActivity();
  if (!activity.data) return null;
  const { counts, items } = activity.data;
  const paid = counts.PAID_AUTO + counts.PAID_APPROVED;
  return (
    <Card>
      <Box gap={3}>
        <Box row gap={2} align="center">
          <Icon name="sparkles" fallback="auto_awesome" size={20} color="primary" />
          <Text weight="semibold">{t("home:agent.title")}</Text>
        </Box>
        {items.length === 0 ? (
          <Text variant="caption">{t("home:agent.empty")}</Text>
        ) : (
          <>
            <Text variant="caption">
              {t("home:agent.summary", { paid, waiting: counts.WAITING, held: counts.HELD })}
            </Text>
            <Box gap={2}>
              {items.slice(0, AGENT_ITEMS).map((i) => (
                <Pressable
                  key={i.proposalId}
                  accessibilityRole="button"
                  onPress={() => router.push(`/order/${i.proposalId}`)}
                >
                  <Box row justify="between" align="center" gap={2}>
                    <Box flex={1} gap={1}>
                      <Text numberOfLines={1}>
                        {i.payeeName || t("home:agent.someone")} ·{" "}
                        {f.money(i.amountMinor, i.currency)}
                      </Text>
                      <Text variant="caption" color="mutedForeground" numberOfLines={2}>
                        {t(`home:agent.by.${i.createdBy}`)}
                        {i.reasonCodes[0] &&
                        i.outcome !== "PAID_AUTO" &&
                        i.outcome !== "PAID_APPROVED"
                          ? ` · ${t(`reasonCodes:${i.reasonCodes[0]}.label`)}`
                          : ""}
                      </Text>
                    </Box>
                    <StatusChip
                      tone={OUTCOME_TONE[i.outcome]}
                      label={t(`home:agent.outcome.${i.outcome}`)}
                    />
                  </Box>
                </Pressable>
              ))}
            </Box>
          </>
        )}
        <Text variant="caption" color="mutedForeground">
          {t("home:agent.footer")}
        </Text>
      </Box>
    </Card>
  );
}

/** History lines shown before "Show all". */
const HISTORY_COLLAPSED = 3;

/**
 * What the imported bank statements show (GET /history; the lines are written by the server from the numbers), or an
 * invitation to import them. Hidden while loading or on error: the rest of Home carries the page.
 */
function HistoryCard() {
  const t = useKassaT();
  const f = useFormat();
  const history = useMoneyHistory();
  const [all, setAll] = useState(false);
  if (!history.data) return null;
  const h = history.data.history;
  if (!h)
    return (
      <Card>
        <Box gap={3}>
          <Text weight="semibold">{t("home:history.emptyTitle")}</Text>
          <Text variant="caption">{t("home:history.emptyBody")}</Text>
          <Button variant="outline" onPress={() => router.push("/data")}>
            {t("home:history.import")}
          </Button>
        </Box>
      </Card>
    );
  const shown = all ? h.notes : h.notes.slice(0, HISTORY_COLLAPSED);
  return (
    <Card>
      <Box gap={2}>
        <Text weight="semibold">{t("home:history.title")}</Text>
        {h.from && h.to ? (
          <Text variant="caption" color="mutedForeground">
            {t("home:history.period", {
              from: f.date(h.from, "medium"),
              to: f.date(h.to, "medium"),
              rows: h.counts.rows,
            })}
          </Text>
        ) : null}
        {shown.map((n) => (
          <Text key={n} variant="caption">
            • {n}
          </Text>
        ))}
        <Box row gap={2}>
          {h.notes.length > HISTORY_COLLAPSED ? (
            <Button size="sm" variant="ghost" onPress={() => setAll((v) => !v)}>
              {all ? t("home:history.less") : t("home:history.all", { count: h.notes.length })}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onPress={() => router.push("/data")}>
            {t("home:history.update")}
          </Button>
        </Box>
      </Box>
    </Card>
  );
}

/** Budgets listed before "Show all" (the ones that need attention come first). */
const BUDGETS_COLLAPSED = 4;

const ON_HERO = "#ffffff";
const ON_HERO_MUTED = "rgba(255,255,255,0.72)";

/** Round action under the balance: white disc, brand-green glyph, label below. */
function HeroAction({
  label,
  sf,
  md,
  onPress,
}: {
  label: string;
  sf: string;
  md: string;
  onPress: () => void;
}) {
  // A plain View takes the third of the row: Pressable's style function is not reliably applied on iOS here.
  return (
    <View style={{ width: "33.333%", alignItems: "center" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        hitSlop={8}
        style={{ alignItems: "center", gap: 6 }}
      >
        <View
          style={{
            width: 52,
            height: 52,
            borderRadius: 26,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: ON_HERO,
          }}
        >
          <Icon name={sf} fallback={md} size={22} color="#056347" />
        </View>
        <Text weight="semibold" numberOfLines={1} style={{ color: ON_HERO, fontSize: 13 }}>
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

function BalanceCard() {
  const t = useKassaT();
  const f = useFormat();
  const balances = useBalances();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  return (
    <QueryView query={balances} skeletonRows={2}>
      {(b) => (
        <View
          onLayout={(e) => setSize(e.nativeEvent.layout)}
          style={{
            alignSelf: "stretch",
            width: "100%",
            borderRadius: 24,
            overflow: "hidden",
            padding: 20,
            gap: 18,
            // Shown until the gradient has measured the card.
            backgroundColor: "#0A7A58",
          }}
        >
          {size ? (
            // Pixel-sized: percentage sizes inside an absolutely positioned Svg collapse on iOS.
            <Svg
              style={{ position: "absolute", top: 0, left: 0 }}
              width={size.width}
              height={size.height}
            >
              <Defs>
                <LinearGradient id="kassa-hero" x1="0" y1="0" x2="1" y2="1">
                  <Stop offset="0" stopColor="#0E9F73" />
                  <Stop offset="1" stopColor="#04503A" />
                </LinearGradient>
              </Defs>
              <Rect width={size.width} height={size.height} fill="url(#kassa-hero)" />
            </Svg>
          ) : null}
          <Box gap={1}>
            <Box row justify="between" align="center">
              <Text style={{ color: ON_HERO_MUTED, fontSize: 14 }}>
                {t("home:totalLabel", { currency: b.homeCurrency })}
              </Text>
              {b.simulated ? <SimulatedBadge /> : null}
            </Box>
            <Text
              variant="title"
              style={{
                color: ON_HERO,
                fontSize: 36,
                lineHeight: 44,
                letterSpacing: -0.8,
                fontVariant: ["tabular-nums"],
              }}
              accessibilityLabel={t("home:totalA11y", {
                amount: f.money(b.homeTotalMinor, b.homeCurrency),
              })}
            >
              {f.money(b.homeTotalMinor, b.homeCurrency)}
            </Text>
          </Box>
          {b.balances.length > 0 ? (
            <View
              style={{
                borderRadius: 16,
                paddingHorizontal: 14,
                paddingVertical: 6,
                backgroundColor: "rgba(255,255,255,0.10)",
              }}
            >
              {b.balances.map((row, i) => (
                <Box
                  key={row.currency}
                  row
                  justify="between"
                  align="center"
                  style={{
                    minHeight: 40,
                    borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                    borderTopColor: "rgba(255,255,255,0.18)",
                  }}
                >
                  <Text weight="semibold" style={{ color: ON_HERO_MUTED, letterSpacing: 0.5 }}>
                    {row.currency}
                  </Text>
                  <Box style={{ alignItems: "flex-end", paddingVertical: 4 }}>
                    <Text
                      weight="semibold"
                      style={{ color: ON_HERO, fontVariant: ["tabular-nums"] }}
                    >
                      {f.money(row.amountMinor, row.currency)}
                    </Text>
                    {row.currency !== b.homeCurrency ? (
                      <Text style={{ color: ON_HERO_MUTED, fontSize: 12 }}>
                        {t("common:approxHome", {
                          amount: f.money(row.homeAmountMinor, b.homeCurrency),
                        })}
                      </Text>
                    ) : null}
                  </Box>
                </Box>
              ))}
            </View>
          ) : null}
          <View style={{ flexDirection: "row", width: "100%" }}>
            <HeroAction
              label={t("home:addMoney")}
              sf="plus"
              md="add"
              onPress={() => router.push("/add-money")}
            />
            <HeroAction
              label={t("home:send")}
              sf="paperplane.fill"
              md="send"
              onPress={() => router.push("/send")}
            />
            {/* Exchange between the user's own balances (a passkey-signed CONVERT order). */}
            <HeroAction
              label={t("home:convert")}
              sf="arrow.left.arrow.right"
              md="currency_exchange"
              onPress={() => router.push("/convert")}
            />
          </View>
          {b.rateDate ? (
            <Text style={{ color: ON_HERO_MUTED, fontSize: 12, textAlign: "center" }}>
              {t("home:rateDate", { date: f.date(b.rateDate) })}
            </Text>
          ) : null}
        </View>
      )}
    </QueryView>
  );
}

function Alerts() {
  const t = useKassaT();
  const f = useFormat();
  const fees = useCardFees().data;
  const payees = usePayees().data;
  const cooling = payees?.payees.filter((p) => p.status === "COOLING") ?? [];
  const blocked = payees?.payees.filter((p) => p.status === "BLOCKED") ?? [];
  const feeLost = fees?.monthlyFeesLostHomeMinor ?? 0;
  const dcc = fees?.dccWarnings.length ?? 0;
  if (feeLost <= 0 && dcc === 0 && cooling.length === 0 && blocked.length === 0) return null;

  return (
    <RowGroup title={t("home:alerts")} icons>
      {feeLost > 0 && fees ? (
        <Row
          leading={<Icon name="percent" fallback="percent" size={20} color="foreground" />}
          title={t("home:alertFees", { amount: f.money(feeLost, fees.homeCurrency) })}
          subtitle={t("home:alertFeesHint")}
          onPress={() => router.push("/cards")}
        />
      ) : null}
      {dcc > 0 ? (
        <Row
          leading={
            <Icon name="exclamationmark.triangle" fallback="warning" size={20} color="foreground" />
          }
          title={t("home:alertDcc", { count: dcc })}
          onPress={() => router.push("/cards")}
        />
      ) : null}
      {cooling.length > 0 ? (
        <Row
          leading={<Icon name="clock" fallback="schedule" size={20} color="foreground" />}
          title={t("home:alertCooling", { count: cooling.length })}
          subtitle={t("home:alertCoolingHint")}
          onPress={() => router.push("/payees")}
        />
      ) : null}
      {blocked.length > 0 ? (
        <Row
          leading={<Icon name="nosign" fallback="block" size={20} color="destructive" />}
          title={t("home:alertBlocked", { count: blocked.length })}
          onPress={() => router.push("/payees")}
        />
      ) : null}
    </RowGroup>
  );
}

/** Pay by what it is for: one shortcut per recipient category, then all recipients. */
export function PayTo() {
  const t = useKassaT();
  const { colors } = useTheme();
  return (
    <Box gap={3}>
      <Box row justify="between" align="center">
        <Text variant="heading">{t("home:payTo")}</Text>
        <Button size="sm" variant="ghost" onPress={() => router.push("/payees")}>
          {t("home:allRecipients")}
        </Button>
      </Box>
      <Box row gap={2} style={{ flexWrap: "wrap" }}>
        {CATEGORIES.map((c) => (
          <Pressable
            key={c}
            accessibilityRole="button"
            testID={`home-pay-${c}`}
            onPress={() => router.push(`/payees?category=${c}`)}
            style={{
              flexGrow: 1,
              flexBasis: 64,
              alignItems: "center",
              gap: 6,
              paddingVertical: 12,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.card,
            }}
          >
            <Icon
              name={CATEGORY_ICON[c].sf}
              fallback={CATEGORY_ICON[c].md}
              size={22}
              color="brandAccent"
            />
            <Text variant="caption">{t(`payees:category.${c}`)}</Text>
          </Pressable>
        ))}
      </Box>
    </Box>
  );
}

export function HomeScreen() {
  const t = useKassaT();
  const me = useMe();
  const budgets = useBudgets();
  const obligations = useObligations();
  const pending = usePendingProposals();
  const balances = useBalances();
  const [showAllBudgets, setShowAllBudgets] = useState(false);
  useRequireBackupCodes();

  const refresh = () =>
    Promise.all([
      me.refetch(),
      balances.refetch(),
      budgets.refetch(),
      obligations.refetch(),
      pending.refetch(),
    ]);

  const homeCurrency = me.data?.homeCurrency ?? balances.data?.homeCurrency ?? "KZT";

  return (
    <>
      <Stack.Screen options={{ headerRight: () => <FreezeButton /> }} />
      <ScrollScreen onRefresh={refresh} testID="home-screen">
        {me.data?.frozenAt ? (
          <Card>
            <Box row gap={3} align="center">
              <Icon name="snowflake" fallback="ac_unit" size={22} color="destructive" />
              <Box flex={1} gap={1}>
                <Text weight="semibold">{t("home:frozenTitle")}</Text>
                <Text variant="caption">{t("home:frozenBody")}</Text>
              </Box>
            </Box>
          </Card>
        ) : null}

        <BalanceCard />

        <PayTo />

        {pending.data && pending.data.proposals.length > 0 ? (
          <Box gap={3}>
            <Text variant="heading">{t("home:toSign")}</Text>
            {pending.data.proposals.map((p) => (
              <ProposalCard key={p.proposalId} proposal={p} />
            ))}
          </Box>
        ) : null}

        <AgentActivityCard />

        <MonthSpend />

        <HistoryCard />

        <Box gap={3}>
          <Box row justify="between" align="center">
            <Text variant="heading">{t("home:budgets")}</Text>
            {/* Budgets are rules, changed with a passkey: KassaLite shows them but has no editor. */}
            {isLiteBuild() ? null : (
              <Button size="sm" variant="ghost" onPress={() => router.push("/settings")}>
                {t("home:editBudgets")}
              </Button>
            )}
          </Box>
          <QueryView
            query={budgets}
            isEmpty={(b) => b.budgets.length === 0}
            empty={
              <Card>
                <Box gap={3}>
                  <Text variant="caption">{t("home:noBudgets")}</Text>
                  {isLiteBuild() ? null : (
                    <Button variant="outline" onPress={() => router.push("/settings")}>
                      {t("home:addBudget.open")}
                    </Button>
                  )}
                </Box>
              </Card>
            }
          >
            {(b) => {
              const sorted = sortBudgets(b.budgets);
              const shown = showAllBudgets ? sorted : sorted.slice(0, BUDGETS_COLLAPSED);
              return (
                <Box gap={3}>
                  <BudgetsSummary budgets={b.budgets} homeCurrency={b.homeCurrency} />
                  <Card>
                    <Box>
                      {shown.map((budget, i) => (
                        <View key={budget.id}>
                          {i > 0 ? <Divider spacing={0} /> : null}
                          <BudgetBar budget={budget} homeCurrency={b.homeCurrency} />
                        </View>
                      ))}
                      {sorted.length > BUDGETS_COLLAPSED ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onPress={() => setShowAllBudgets((v) => !v)}
                        >
                          {showAllBudgets
                            ? t("home:showFewerBudgets")
                            : t("home:showAllBudgets", { count: sorted.length })}
                        </Button>
                      ) : null}
                    </Box>
                  </Card>
                </Box>
              );
            }}
          </QueryView>
        </Box>

        <Box gap={3}>
          <Box row justify="between" align="center">
            <Text variant="heading">{t("home:upcoming")}</Text>
            <StatusChip
              tone="neutral"
              label={t("home:next45")}
              icon={{ sf: "calendar", md: "event" }}
            />
          </Box>
          <QueryView
            query={obligations}
            isEmpty={(o) => o.obligations.length === 0}
            empty={<Text variant="caption">{t("home:noBills")}</Text>}
          >
            {(o) => (
              <RowGroup>
                {o.obligations.slice(0, UPCOMING_LIMIT).map((ob) => (
                  <ObligationRow key={ob.id} obligation={ob} homeCurrency={homeCurrency} />
                ))}
                <Row title={t("home:allBills")} onPress={() => router.push("/bills")} />
              </RowGroup>
            )}
          </QueryView>
        </Box>

        <Alerts />

        <RowGroup title={t("home:more")} icons>
          <Row
            leading={
              <Icon name="chart.bar.xaxis" fallback="insights" size={20} color="foreground" />
            }
            title={t("insights:title")}
            onPress={openInsights}
          />
          <Row
            leading={<Icon name="person.2" fallback="group" size={20} color="foreground" />}
            title={t("payees:title")}
            onPress={() => router.push("/payees")}
          />
          <Row
            leading={
              <Icon
                name="doc.text.magnifyingglass"
                fallback="description"
                size={20}
                color="foreground"
              />
            }
            title={t("credit:title")}
            onPress={() => router.push("/credit-record")}
          />
        </RowGroup>
        <View />
      </ScrollScreen>
    </>
  );
}
