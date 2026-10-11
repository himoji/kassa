import { router, Stack } from "expo-router";
import { View } from "react-native";

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
import { BudgetBar } from "@/components/kassa/budget-bar";
import { FreezeButton } from "@/components/kassa/freeze-button";
import { ObligationRow } from "@/components/kassa/obligation-row";
import { ProposalCard } from "@/components/kassa/proposal-card";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { StatusChip } from "@/components/kassa/status-chip";
import { Box, Card, Icon, Row, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

const UPCOMING_LIMIT = 4;

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

export function HomeScreen() {
  const t = useKassaT();
  const me = useMe();
  const budgets = useBudgets();
  const obligations = useObligations();
  const pending = usePendingProposals();
  const balances = useBalances();
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

        {pending.data && pending.data.proposals.length > 0 ? (
          <Box gap={3}>
            <Text variant="heading">{t("home:toSign")}</Text>
            {pending.data.proposals.map((p) => (
              <ProposalCard key={p.proposalId} proposal={p} />
            ))}
          </Box>
        ) : null}

        <Box gap={3}>
          <Text variant="heading">{t("home:budgets")}</Text>
          <QueryView
            query={budgets}
            isEmpty={(b) => b.budgets.length === 0}
            empty={<Text variant="caption">{t("home:noBudgets")}</Text>}
          >
            {(b) => (
              <Card>
                <Box gap={5}>
                  {b.budgets.map((budget) => (
                    <BudgetBar key={budget.id} budget={budget} homeCurrency={b.homeCurrency} />
                  ))}
                </Box>
              </Card>
            )}
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
