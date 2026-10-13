/**
 * The "your rules" planner: salary, bills and budgets per month against a savings goal. Every change recomputes at
 * once (shared/plan.ts) what is left each month and where the goal lands; "Fit my goal" asks the server
 * (POST /plan/advice, AI-written when allowed) which budgets to trim, and "Apply" moves those sliders. The goal itself
 * stays on this device (stores/savings-goal.ts).
 */
import { planOutcome, withBudgetChanges, type PlanAdviceResponse } from "@kassa/shared";
import { useState } from "react";
import { View } from "react-native";

import { usePlanAdvice } from "@/api/hooks/plan";
import { Box, Button, Card, Text, useTheme } from "@/components/ui";
import { categoryEmoji } from "@/lib/category-emoji";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";
import { setSavingsGoal, useSavingsGoal } from "@/stores/savings-goal";
import { statusColor } from "@/theme/status";

import { errorText } from "./error-text";
import { MoneyInput } from "./money-input";
import { Segmented } from "./segmented";

type Budget = { category: string; limitHomeMinor: number };

const MONTH_CHOICES = ["3", "6", "12", "24"] as const;

/** One line of the monthly sum: label left, amount right. */
function SumLine({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <Box row justify="between" gap={3}>
      <Text variant={strong ? undefined : "caption"} weight={strong ? "semibold" : undefined}>
        {label}
      </Text>
      <Text weight={strong ? "semibold" : "medium"} style={{ fontVariant: ["tabular-nums"] }}>
        {value}
      </Text>
    </Box>
  );
}

/** Savings by month as small bars, the goal as a line across them. */
function MonthBars({
  perMonth,
  months,
  goal,
}: {
  perMonth: number;
  months: number;
  goal: number | null;
}) {
  const { colors, mode } = useTheme();
  const shown = Math.min(months, 12);
  const step = months / shown;
  const top = Math.max(goal ?? 0, perMonth * months, 1);
  const goalTop = goal ? 1 - goal / top : null;
  return (
    <View style={{ height: 72, flexDirection: "row", alignItems: "flex-end", gap: 4 }}>
      {Array.from({ length: shown }, (_, i) => {
        const saved = Math.max(0, perMonth) * Math.round((i + 1) * step);
        const reached = goal !== null && saved >= goal;
        return (
          <View
            key={i}
            style={{
              flex: 1,
              height: `${Math.max(2, (saved / top) * 100)}%`,
              borderRadius: 4,
              backgroundColor: reached ? statusColor("positive", mode) : colors.brandAccent,
              opacity: reached ? 1 : 0.35 + (0.65 * (i + 1)) / shown,
            }}
          />
        );
      })}
      {goalTop !== null ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: `${goalTop * 100}%`,
            borderTopWidth: 1,
            borderStyle: "dashed",
            borderColor: colors.foreground,
          }}
        />
      ) : null}
    </View>
  );
}

export function SavingsPlanner({
  currency,
  incomeMinor,
  onIncomeChange,
  fixedMinor,
  budgets,
  onApplyBudgets,
  disabled,
}: {
  currency: string;
  incomeMinor: number;
  onIncomeChange: (minor: number) => void;
  fixedMinor: number;
  budgets: readonly Budget[];
  onApplyBudgets: (changes: Budget[]) => void;
  disabled?: boolean;
}) {
  const t = useKassaT();
  const f = useFormat();
  const { mode } = useTheme();
  const goal = useSavingsGoal(currency);
  const advice = usePlanAdvice();
  const [suggestion, setSuggestion] = useState<PlanAdviceResponse | null>(null);
  const [adviceError, setAdviceError] = useState<string | null>(null);

  const goalInput = goal.amountMinor
    ? { amountMinor: goal.amountMinor, months: goal.months }
    : null;
  const o = planOutcome({
    monthlyIncomeMinor: incomeMinor,
    fixedMonthlyMinor: fixedMinor,
    budgets,
    goal: goalInput,
    months: goal.months,
  });
  const money = (minor: number) => f.money(minor, currency);
  const leftTone =
    o.monthlyLeftMinor < 0 ? "critical" : goalInput && !o.goalReached ? "warning" : "positive";

  const askAdvice = async () => {
    if (!goalInput) return;
    setAdviceError(null);
    try {
      setSuggestion(
        await advice.mutateAsync({
          currency,
          monthlyIncomeMinor: incomeMinor,
          fixedMonthlyMinor: fixedMinor,
          budgets: budgets.map((b) => ({ category: b.category, limitHomeMinor: b.limitHomeMinor })),
          goal: goalInput,
        })
      );
    } catch (err) {
      setAdviceError(errorText(t, err));
    }
  };

  // A suggestion made for other numbers is dropped as soon as the user changes anything it was based on.
  const suggestionStillFits =
    suggestion &&
    planOutcome({
      monthlyIncomeMinor: incomeMinor,
      fixedMonthlyMinor: fixedMinor,
      budgets: withBudgetChanges(budgets, suggestion.budgets),
      goal: goalInput,
    }).monthlyLeftMinor === suggestion.monthlyLeftMinor;

  return (
    <Box gap={4} testID="savings-planner">
      <Box gap={1}>
        <Text variant="label">{t("onboarding:planner.title")}</Text>
        <Text variant="caption">{t("onboarding:planner.intro")}</Text>
      </Box>

      <Box gap={2}>
        <Text variant="caption">{t("onboarding:planner.salary")}</Text>
        <MoneyInput
          valueMinor={incomeMinor}
          currency={currency}
          onChange={(v) => v !== null && onIncomeChange(v)}
          accessibilityLabel={t("onboarding:planner.salary")}
          testID="planner-salary"
        />
      </Box>

      <Box gap={2}>
        <Text variant="caption">{t("onboarding:planner.goal")}</Text>
        <MoneyInput
          valueMinor={goal.amountMinor}
          currency={currency}
          onChange={(v) => setSavingsGoal({ amountMinor: v && v > 0 ? v : null, currency })}
          accessibilityLabel={t("onboarding:planner.goal")}
          placeholder={t("onboarding:planner.goalPlaceholder")}
          testID="planner-goal"
        />
        <Segmented
          value={String(goal.months) as (typeof MONTH_CHOICES)[number]}
          onChange={(m) => setSavingsGoal({ months: Number(m), currency })}
          options={MONTH_CHOICES.map((m) => ({
            value: m,
            label: t("onboarding:planner.months", { count: Number(m) }),
          }))}
        />
      </Box>

      <Card>
        <Box gap={2}>
          <SumLine label={t("onboarding:planner.income")} value={money(incomeMinor)} />
          <SumLine label={t("onboarding:planner.bills")} value={`− ${money(fixedMinor)}`} />
          <SumLine
            label={t("onboarding:planner.budgets")}
            value={`− ${money(o.budgetsTotalMinor)}`}
          />
          <View style={{ height: 1, backgroundColor: statusColor(leftTone, mode), opacity: 0.4 }} />
          <Box row justify="between" gap={3} align="center">
            <Text weight="semibold">{t("onboarding:planner.left")}</Text>
            <Text
              weight="bold"
              style={{
                fontSize: 22,
                fontVariant: ["tabular-nums"],
                color: statusColor(leftTone, mode),
              }}
              testID="planner-left"
            >
              {money(o.monthlyLeftMinor)}
            </Text>
          </Box>
          <MonthBars
            perMonth={o.monthlyLeftMinor}
            months={goal.months}
            goal={goalInput?.amountMinor ?? null}
          />
          <Text testID="planner-projection">
            {t("onboarding:planner.projection", {
              count: goal.months,
              amount: money(o.projectedMinor),
            })}
          </Text>
          {goalInput ? (
            <Text variant="caption" style={{ color: statusColor(leftTone, mode) }}>
              {o.goalReached
                ? t("onboarding:planner.goalReached", { count: o.monthsToGoal ?? goal.months })
                : o.monthsToGoal
                  ? t("onboarding:planner.goalShort", {
                      short: money(goalInput.amountMinor - o.projectedMinor),
                      need: money(o.neededPerMonthMinor),
                      count: o.monthsToGoal,
                    })
                  : t("onboarding:planner.nothingLeft")}
            </Text>
          ) : null}
        </Box>
      </Card>

      {goalInput ? (
        <Box gap={2}>
          <Button
            variant="outline"
            loading={advice.isPending}
            disabled={disabled}
            onPress={() => void askAdvice()}
          >
            {t("onboarding:planner.ask")}
          </Button>
          {adviceError ? <Text color="destructive">{adviceError}</Text> : null}
          {suggestion && suggestionStillFits ? (
            <Card>
              <Box gap={2} testID="planner-advice">
                <Text variant="caption">
                  {t(
                    suggestion.source === "AI"
                      ? "onboarding:planner.fromAi"
                      : "onboarding:planner.fromRules"
                  )}
                </Text>
                <Text>{suggestion.summary}</Text>
                {suggestion.budgets.map((b) => {
                  const was = budgets.find((x) => x.category === b.category)?.limitHomeMinor ?? 0;
                  return (
                    <SumLine
                      key={b.category}
                      label={`${categoryEmoji(b.category)} ${t(`common:category.${b.category}`, { defaultValue: b.category })}`}
                      value={`${money(was)} → ${money(b.limitHomeMinor)}`}
                    />
                  );
                })}
                {suggestion.budgets.length > 0 ? (
                  <Button
                    disabled={disabled}
                    onPress={() => {
                      onApplyBudgets(suggestion.budgets);
                      setSuggestion(null);
                    }}
                  >
                    {t("onboarding:planner.apply")}
                  </Button>
                ) : null}
              </Box>
            </Card>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
