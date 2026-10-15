import type { ImportCommitResponse, ImportPreviewResponse } from "@kassa/shared";
import { useState } from "react";
import { TextInput } from "react-native";

import {
  canPickFiles,
  pickImportFiles,
  useExportData,
  useImportCommit,
  useImportFiles,
  useImportPreview,
} from "@/api/hooks/dataport";
import { useSetBudgets } from "@/api/hooks/money";
import { RowGroup } from "@/components/row-group";
import { errorText } from "@/components/kassa/error-text";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Box, Button, Card, Text, useTheme } from "@/components/ui";
import { readClipboard } from "@/lib/clipboard";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { PasskeyCancelledError } from "@/lib/passkey-errors";

import { ALL_ON, ImportPreviewCard, selectedItems, type SectionSwitches } from "./import-preview";

/**
 * Import & export (Settings, in the app and in KassaLite): Kassa's JSON export, and a previewed import of bank
 * statements (PDF, CSV, Excel, OFX; several at once) or any app's JSON. Nothing is written before the user imports.
 */
export function DataScreen() {
  const t = useKassaT();
  const { colors } = useTheme();
  const exportData = useExportData();
  const preview = useImportPreview();
  const upload = useImportFiles();
  const commit = useImportCommit();
  const setBudgets = useSetBudgets();
  const [text, setText] = useState("");
  const [result, setResult] = useState<ImportPreviewResponse | null>(null);
  const [on, setOn] = useState<SectionSwitches>(ALL_ON);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
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

  const chooseFiles = async () => {
    setError(null);
    setDone(null);
    if (!canPickFiles()) {
      setError(t("settings:data.chooseFileUnavailable"));
      return;
    }
    const files = await pickImportFiles();
    if (!files) return;
    setResult(null);
    try {
      setResult(await upload.mutateAsync({ files }));
      setOn(ALL_ON);
    } catch (err) {
      haptics.error();
      setError(errorText(t, err));
    }
  };

  const doImport = async () => {
    if (!result) return;
    setError(null);
    const selected = selectedItems(result, on);
    try {
      const res = await commit.mutateAsync({
        items: { ...selected, budgets: [] },
        history: result.history,
        onProgress: (d, n) => setProgress({ done: d, total: n }),
      });
      let budgets = 0;
      if (selected.budgets.length > 0) {
        try {
          budgets = (await setBudgets.mutateAsync(selected.budgets)).applied.length;
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
            <Button loading={upload.isPending} onPress={() => void chooseFiles()}>
              {t("settings:data.chooseFile")}
            </Button>
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

      {upload.isPending ? <Text variant="caption">{t("settings:data.reading")}</Text> : null}
      {commit.isPending && result ? (
        <Text variant="caption">
          {t("settings:data.importing", {
            done: progress?.done ?? 0,
            count: progress?.total ?? result.items.transactions.length,
          })}
        </Text>
      ) : null}
      {result ? (
        <ImportPreviewCard
          result={result}
          on={on}
          setOn={setOn}
          onImport={() => void doImport()}
          busy={commit.isPending || setBudgets.isPending}
          importLabel={t("settings:data.import")}
        />
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
                incomes: done.res.incomes.added,
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
