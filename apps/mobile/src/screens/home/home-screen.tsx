import { router, Stack } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { useSpendingInsights } from "@/api/hooks/insights";
import { useMe } from "@/api/hooks/me";
import {
  useBalances,
  useBudgets,
  useCardFees,
  useObligations,
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
import { MonthSummaryCard, openInsights } from "@/screens/insights/insights-screen";
import { CATEGORIES, CATEGORY_ICON } from "@/screens/payees/recipient-fields";

const UPCOMING_LIMIT = 4;

/** This month's spending at a glance; opens Insights. Hidden until it loads (the budgets below carry the page). */
function MonthSpend() {
  const insights = useSpendingInsights();
  return insights.data ? <MonthSummaryCard data={insights.data} onPress={openInsights} /> : null;
}
/** Budgets listed before "Show all" (the ones that need attention come first). */
const BUDGETS_COLLAPSED = 4;

function BalanceCard() {
  const t = useKassaT();
  const f = useFormat();
  const balances = useBalances();
  return (
    <QueryView query={balances} skeletonRows={2}>
      {(b) => (
        <Card>
          <Box gap={3}>
            <Box row justify="between" align="center">
              <Text variant="caption">{t("home:totalLabel", { currency: b.homeCurrency })}</Text>
              {b.simulated ? <SimulatedBadge /> : null}
            </Box>
            <Text
              variant="title"
              style={{ fontSize: 34, lineHeight: 40, fontVariant: ["tabular-nums"] }}
              accessibilityLabel={t("home:totalA11y", {
                amount: f.money(b.homeTotalMinor, b.homeCurrency),
              })}
            >
              {f.money(b.homeTotalMinor, b.homeCurrency)}
            </Text>
            <Box gap={2}>
              {b.balances.map((row) => (
                <Box
                  key={row.currency}
                  row
                  justify="between"
                  align="center"
                  style={{ minHeight: 28 }}
                >
                  <Text>{row.currency}</Text>
                  <Box style={{ alignItems: "flex-end" }}>
                    <Text weight="semibold" style={{ fontVariant: ["tabular-nums"] }}>
                      {f.money(row.amountMinor, row.currency)}
                    </Text>
                    {row.currency !== b.homeCurrency ? (
                      <Text variant="caption">
                        {t("common:approxHome", {
                          amount: f.money(row.homeAmountMinor, b.homeCurrency),
                        })}
                      </Text>
                    ) : null}
                  </Box>
                </Box>
              ))}
            </Box>
            {b.rateDate ? (
              <Text variant="caption">{t("home:rateDate", { date: f.date(b.rateDate) })}</Text>
            ) : null}
            <Box row gap={2}>
              <Button
                style={{ flex: 1 }}
                onPress={() => router.push("/add-money")}
                leftIcon={<Icon name="plus" fallback="add" size={18} color="primaryForeground" />}
              >
                {t("home:addMoney")}
              </Button>
              <Button
                style={{ flex: 1 }}
                variant="secondary"
                onPress={() => router.push("/send")}
                leftIcon={<Icon name="paperplane" fallback="send" size={18} color="foreground" />}
              >
                {t("home:send")}
              </Button>
            </Box>
          </Box>
        </Card>
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
function PayTo() {
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
  const refreshing = me.isRefetching || balances.isRefetching || budgets.isRefetching;

  const refresh = () => {
    void me.refetch();
    void balances.refetch();
    void budgets.refetch();
    void obligations.refetch();
    void pending.refetch();
  };

  const homeCurrency = me.data?.homeCurrency ?? balances.data?.homeCurrency ?? "KZT";

  return (
    <>
      <Stack.Screen options={{ headerRight: () => <FreezeButton /> }} />
      <ScrollScreen onRefresh={refresh} refreshing={refreshing} testID="home-screen">
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

        <MonthSpend />

        <Box gap={3}>
          <Box row justify="between" align="center">
            <Text variant="heading">{t("home:budgets")}</Text>
            <Button size="sm" variant="ghost" onPress={() => router.push("/settings")}>
              {t("home:editBudgets")}
            </Button>
          </Box>
          <QueryView
            query={budgets}
            isEmpty={(b) => b.budgets.length === 0}
            empty={
              <Card>
                <Box gap={3}>
                  <Text variant="caption">{t("home:noBudgets")}</Text>
                  <Button variant="outline" onPress={() => router.push("/settings")}>
                    {t("home:addBudget.open")}
                  </Button>
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
