import type { ImportCommitResponse, ImportItems, ImportPreviewResponse } from "@kassa/shared";
import { useState } from "react";
import { Platform, TextInput } from "react-native";

import {
  pickJsonFileOnWeb,
  useExportData,
  useImportCommit,
  useImportPreview,
} from "@/api/hooks/dataport";
import { useSetBudgets } from "@/api/hooks/money";
import { RowGroup } from "@/components/row-group";
import { errorText } from "@/components/kassa/error-text";
import { SettingSwitch } from "@/components/kassa/native-controls";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Box, Button, Card, Text, useTheme } from "@/components/ui";
import { readClipboard } from "@/lib/clipboard";
import { useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { PasskeyCancelledError } from "@/lib/passkey-errors";

type Section = keyof ImportItems;
const SECTIONS: Section[] = ["transactions", "bills", "cards", "budgets"];

/** Import & export (Settings): Kassa's JSON export, and a previewed import of Kassa's or any other app's JSON. */
export function DataScreen() {
  const t = useKassaT();
  const f = useFormat();
  const { colors } = useTheme();
  const exportData = useExportData();
  const preview = useImportPreview();
  const commit = useImportCommit();
  const setBudgets = useSetBudgets();
  const [text, setText] = useState("");
  const [result, setResult] = useState<ImportPreviewResponse | null>(null);
  const [on, setOn] = useState<Record<Section, boolean>>({
    transactions: true,
    bills: true,
    cards: true,
    budgets: true,
  });
  const [done, setDone] = useState<{ res: ImportCommitResponse; budgets: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (json: string) => {
    setError(null);
    setDone(null);
    setResult(null);
    if (!json.trim()) return;
    try {
      setResult(await preview.mutateAsync(json));
    } catch (err) {
      haptics.error();
      setError(errorText(t, err));
    }
  };

  const doImport = async () => {
    if (!result) return;
    setError(null);
    const items: ImportItems = {
      transactions: on.transactions ? result.items.transactions : [],
      bills: on.bills ? result.items.bills : [],
      cards: on.cards ? result.items.cards : [],
      budgets: [],
    };
    try {
      const res = await commit.mutateAsync(items);
      let budgets = 0;
      if (on.budgets && result.items.budgets.length > 0) {
        try {
          budgets = (await setBudgets.mutateAsync(result.items.budgets)).applied.length;
        } catch (err) {
          if (!(err instanceof PasskeyCancelledError)) setError(errorText(t, err));
        }
      }
      haptics.success();
      setDone({ res, budgets });
      setResult(null);
      setText("");
    } catch (err) {
      haptics.error();
      setError(errorText(t, err));
    }
  };

  return (
    <ScrollScreen>
      <RowGroup title={t("settings:data.exportTitle")} footer={t("settings:data.exportFooter")}>
        <Box p={4}>
          <Button
            variant="outline"
            loading={exportData.isPending}
            onPress={() =>
              void exportData.mutateAsync().catch((err: unknown) => setError(errorText(t, err)))
            }
          >
            {t("settings:data.export")}
          </Button>
        </Box>
      </RowGroup>

      <RowGroup title={t("settings:data.importTitle")} footer={t("settings:data.importFooter")}>
        <Box p={4} gap={3}>
          <Box row gap={2} style={{ flexWrap: "wrap" }}>
            {Platform.OS === "web" ? (
              <Button
                variant="outline"
                onPress={() =>
                  void pickJsonFileOnWeb().then((json) => {
                    if (json === null) return;
                    setText(json);
                    void run(json);
                  })
                }
              >
                {t("settings:data.chooseFile")}
              </Button>
            ) : null}
            <Button
              variant="outline"
              onPress={() =>
                void readClipboard().then((json) => {
                  setText(json);
                  void run(json);
                })
              }
            >
              {t("settings:data.paste")}
            </Button>
          </Box>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder={t("settings:data.placeholder")}
            placeholderTextColor={colors.mutedForeground}
            accessibilityLabel={t("settings:data.placeholder")}
            style={{
              minHeight: 96,
              maxHeight: 200,
              padding: 12,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: colors.border,
              color: colors.foreground,
              fontFamily: "monospace",
              fontSize: 13,
            }}
          />
          <Button
            disabled={!text.trim()}
            loading={preview.isPending}
            onPress={() => void run(text)}
          >
            {t("settings:data.check")}
          </Button>
        </Box>
      </RowGroup>

      {result ? (
        <Card>
          <Box gap={3}>
            <Text weight="semibold">
              {result.source === "kassa"
                ? t("settings:data.fromKassa")
                : t("settings:data.fromOther")}
            </Text>
            {result.mappings.map((m) => (
              <Text key={`${m.path}-${m.kind}`} variant="caption">
                {t("settings:data.mapping", {
                  path: m.path,
                  kind: t(`settings:data.kind.${m.kind}`),
                  imported: m.imported,
                  rows: m.rows,
                  fields: Object.entries(m.fields)
                    .map(([to, from]) => `${from} → ${to}`)
                    .join(", "),
                })}
              </Text>
            ))}
            {SECTIONS.filter((s) => result.items[s].length > 0).map((s) => (
              <SettingSwitch
                key={s}
                label={t(`settings:data.section.${s}`, { count: result.items[s].length })}
                description={s === "budgets" ? t("settings:data.budgetsNote") : undefined}
                value={on[s]}
                onChange={(v) => setOn((o) => ({ ...o, [s]: v }))}
              />
            ))}
            {result.items.transactions.slice(0, 5).map((x, i) => (
              <Box key={i} row justify="between" gap={2}>
                <Text variant="caption" numberOfLines={1} style={{ flexShrink: 1 }}>
                  {f.date(x.occurredAt.slice(0, 10), "medium")} · {x.merchant}
                </Text>
                <Text variant="caption" style={{ fontVariant: ["tabular-nums"] }}>
                  {f.money(x.amountMinor, x.currency)}
                </Text>
              </Box>
            ))}
            {result.warnings.map((w) => (
              <Text key={w} variant="caption" color="mutedForeground">
                {w}
              </Text>
            ))}
            <Button
              size="lg"
              loading={commit.isPending || setBudgets.isPending}
              disabled={!SECTIONS.some((s) => on[s] && result.items[s].length > 0)}
              onPress={() => void doImport()}
            >
              {t("settings:data.import")}
            </Button>
          </Box>
        </Card>
      ) : null}

      {done ? (
        <Card>
          <Box gap={1}>
            <Text weight="semibold">{t("settings:data.doneTitle")}</Text>
            <Text variant="caption">
              {t("settings:data.done", {
                imported: done.res.transactions.imported,
                duplicates: done.res.transactions.duplicates,
                failed: done.res.transactions.failed,
                bills: done.res.bills.added,
                cards: done.res.cards.added,
                budgets: done.budgets,
              })}
            </Text>
          </Box>
        </Card>
      ) : null}
      {error ? <Text color="destructive">{error}</Text> : null}
    </ScrollScreen>
  );
}
