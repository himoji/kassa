/**
 * Add a monthly budget by hand: a category (searchable; a typed name nobody lists becomes its own category) and a
 * limit. Used on the onboarding review sheet and in Settings → Budgets; the caller decides what "add" does.
 */
import { useMemo, useRef, useState } from "react";
import { View } from "react-native";

import { Box, Button, Text } from "@/components/ui";
import { BUDGET_CATEGORIES, categoryId } from "@/lib/categories";
import { categoryEmoji } from "@/lib/category-emoji";
import { useKassaT } from "@/lib/i18n";

import { MoneyInput } from "./money-input";
import { SearchPicker } from "./search-picker";

export function AddBudgetForm({
  currency,
  existing,
  onAdd,
  onCancel,
  disabled,
}: {
  currency: string;
  /** Categories that already have a budget (not offered again). */
  existing: readonly string[];
  onAdd: (budget: { category: string; limitHomeMinor: number }) => void;
  onCancel: () => void;
  disabled?: boolean;
}) {
  const t = useKassaT();
  const [category, setCategory] = useState<string | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const label = (c: string) =>
    `${categoryEmoji(c)} ${t(`common:category.${c}`, { defaultValue: c.replace(/_/g, " ") })}`;
  const options = useMemo(
    () =>
      BUDGET_CATEGORIES.filter((c) => !existing.includes(c)).map((c) => ({
        value: c as string,
        label: label(c),
      })),
    // `label` only depends on `t`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [existing, t]
  );
  // Categories typed by the user: offered like the listed ones once picked.
  const [customs, setCustoms] = useState<{ value: string; label: string }[]>([]);
  const pendingCustom = useRef<{ value: string; name: string } | null>(null);
  const ready = !!category && amount !== null && amount > 0 && !existing.includes(category);

  return (
    <Box gap={3} testID="add-budget-form">
      <View style={{ marginHorizontal: -16 }}>
        <SearchPicker
          label={t("home:addBudget.category")}
          value={category}
          options={[...options, ...customs]}
          onChange={(c) => {
            const typed = pendingCustom.current;
            if (typed && typed.value === c && !customs.some((x) => x.value === c)) {
              setCustoms((list) => [
                ...list,
                { value: c, label: `${categoryEmoji(c)} ${typed.name}` },
              ]);
            }
            setCategory(c);
          }}
          custom={(q) => {
            const id = categoryId(q);
            if (!id || existing.includes(id)) return null;
            pendingCustom.current = { value: id, name: q.trim() };
            return { value: id, label: t("home:addBudget.newCategory", { name: q.trim() }) };
          }}
          testID="add-budget-category"
        />
      </View>
      <MoneyInput
        valueMinor={amount}
        currency={currency}
        onChange={setAmount}
        accessibilityLabel={t("home:addBudget.limit")}
        placeholder={t("home:addBudget.limit")}
        testID="add-budget-amount"
      />
      {category && existing.includes(category) ? (
        <Text variant="caption" color="destructive">
          {t("home:addBudget.exists")}
        </Text>
      ) : null}
      <Box row gap={2}>
        <Button variant="ghost" onPress={onCancel} style={{ flex: 1 }}>
          {t("common:cancel")}
        </Button>
        <Button
          disabled={!ready || disabled}
          onPress={() => {
            if (!category || amount === null) return;
            onAdd({ category, limitHomeMinor: amount });
            setCategory(null);
            setAmount(null);
          }}
          style={{ flex: 1 }}
        >
          {t("home:addBudget.add")}
        </Button>
      </Box>
    </Box>
  );
}
