import type { BudgetDto } from "@kassa/shared";
import { useState } from "react";

import { useBudgets, useSetBudgets } from "@/api/hooks/money";
import { RowGroup } from "@/components/row-group";
import { AddBudgetForm } from "@/components/kassa/add-budget-form";
import { AmountsEditor } from "@/components/kassa/amounts-editor";
import { errorText } from "@/components/kassa/error-text";
import { QueryView } from "@/components/kassa/query-view";
import { Box, Button, Row, Text } from "@/components/ui";
import { amountRange } from "@/lib/amount-slider";
import { categoryEmoji } from "@/lib/category-emoji";
import { useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { PasskeyCancelledError } from "@/lib/passkey-errors";

type Limit = { category: string; limitHomeMinor: number };

/**
 * This month's budgets: change limits with sliders or add a budget by hand (PUT /budgets). A new or lower limit
 * applies at once; a higher one asks for the passkey first (I8).
 */
export function BudgetsSection() {
  const t = useKassaT();
  const f = useFormat();
  const budgets = useBudgets();
  const save = useSetBudgets();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Limit[]>([]);
  const [error, setError] = useState<string | null>(null);

  const label = (c: string) => t(`common:category.${c}`, { defaultValue: c.replace(/_/g, " ") });

  const start = (current: readonly BudgetDto[]) => {
    setDraft(current.map((b) => ({ category: b.category, limitHomeMinor: b.limitHomeMinor })));
    setError(null);
    setEditing(true);
  };

  const stop = () => {
    setEditing(false);
    setAdding(false);
    setError(null);
  };

  return (
    <QueryView query={budgets} skeletonRows={2}>
      {({ budgets: current, homeCurrency }) => {
        const before = new Map(current.map((b) => [b.category, b.limitHomeMinor]));
        const changed = draft.filter((d) => before.get(d.category) !== d.limitHomeMinor);
        const onSave = async () => {
          setError(null);
          try {
            await save.mutateAsync(changed);
            haptics.success();
            stop();
          } catch (err) {
            if (err instanceof PasskeyCancelledError) return;
            haptics.error();
            setError(errorText(t, err));
          }
        };
        return (
          <RowGroup title={t("settings:budgets.title")} footer={t("settings:budgets.footer")}>
            {editing ? (
              <Box p={4} gap={4}>
                {draft.length > 0 ? (
                  <AmountsEditor
                    currency={homeCurrency}
                    disabled={save.isPending}
                    totalLabel={t("chat:choice.total")}
                    items={draft.map((d) => ({
                      id: d.category,
                      label: label(d.category),
                      emoji: categoryEmoji(d.category),
                      valueMinor: d.limitHomeMinor,
                      range: amountRange(before.get(d.category) ?? d.limitHomeMinor, {
                        minMinor: 1,
                      }),
                    }))}
                    onChange={(category, v) =>
                      setDraft((list) =>
                        list.map((d) =>
                          d.category === category ? { category, limitHomeMinor: Math.max(1, v) } : d
                        )
                      )
                    }
                  />
                ) : null}
                {adding ? (
                  <AddBudgetForm
                    currency={homeCurrency}
                    existing={draft.map((d) => d.category)}
                    disabled={save.isPending}
                    onCancel={() => setAdding(false)}
                    onAdd={(b) => {
                      setDraft((list) => [...list, b]);
                      setAdding(false);
                    }}
                  />
                ) : (
                  <Button
                    variant="outline"
                    disabled={save.isPending || draft.length >= 20}
                    onPress={() => setAdding(true)}
                  >
                    {t("home:addBudget.open")}
                  </Button>
                )}
                {error ? <Text color="destructive">{error}</Text> : null}
                <Box row gap={2}>
                  <Box flex={1}>
                    <Button variant="outline" onPress={stop}>
                      {t("common:cancel")}
                    </Button>
                  </Box>
                  <Box flex={1}>
                    <Button
                      loading={save.isPending}
                      disabled={changed.length === 0}
                      onPress={() => void onSave()}
                    >
                      {t("settings:budgets.save")}
                    </Button>
                  </Box>
                </Box>
              </Box>
            ) : (
              <>
                {current.length === 0 ? (
                  <Box p={4}>
                    <Text variant="caption">{t("home:noBudgets")}</Text>
                  </Box>
                ) : (
                  current.map((b) => (
                    <Row
                      key={b.id}
                      title={`${categoryEmoji(b.category)} ${label(b.category)}`}
                      trailing={
                        <Text weight="semibold" style={{ fontVariant: ["tabular-nums"] }}>
                          {f.money(b.limitHomeMinor, homeCurrency)}
                        </Text>
                      }
                    />
                  ))
                )}
                <Box p={3} row gap={2}>
                  <Box flex={1}>
                    <Button
                      variant="outline"
                      onPress={() => {
                        start(current);
                        setAdding(true);
                      }}
                    >
                      {t("home:addBudget.open")}
                    </Button>
                  </Box>
                  {current.length > 0 ? (
                    <Box flex={1}>
                      <Button variant="outline" onPress={() => start(current)}>
                        {t("settings:budgets.edit")}
                      </Button>
                    </Box>
                  ) : null}
                </Box>
              </>
            )}
          </RowGroup>
        );
      }}
    </QueryView>
  );
}
