import type { ImportCommitResponse, ImportPreviewResponse } from "@kassa/shared";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, TextInput, View } from "react-native";

import {
  canPickFiles,
  pickImportFiles,
  useImportCommit,
  useImportFiles,
  useImportPreview,
  type PickedFile,
} from "@/api/hooks/dataport";
import { useSetBudgets } from "@/api/hooks/money";
import { errorText } from "@/components/kassa/error-text";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Box, Button, Card, Icon, Text, useTheme } from "@/components/ui";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { PasskeyCancelledError } from "@/lib/passkey-errors";

import {
  ALL_ON,
  ImportPreviewCard,
  selectedItems,
  type SectionSwitches,
} from "../settings/import-preview";

/** Most files one upload takes (the server's limit). */
const MAX_FILES = 6;

/**
 * Import bank statements, one step at a time: pick (or, on the web, drop) the PDFs the bank app exports, see what Kassa
 * read, tap Import. Opened from Home, the Add page and Settings, in the app and in KassaLite. The server reads any
 * bank's PDF, CSV or Excel in any language; nothing is written until Import.
 */
export function ImportScreen() {
  const t = useKassaT();
  const { colors } = useTheme();
  const upload = useImportFiles();
  const preview = useImportPreview();
  const commit = useImportCommit();
  const setBudgets = useSetBudgets();
  const [result, setResult] = useState<ImportPreviewResponse | null>(null);
  const [on, setOn] = useState<SectionSwitches>(ALL_ON);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [done, setDone] = useState<{ res: ImportCommitResponse; budgets: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const drop = useRef<View>(null);
  const reading = upload.isPending || preview.isPending;
  // The plain-language text, plus the reason when it is not one the app knows (so a report says what failed).
  const failure = (err: unknown) => {
    const text = errorText(t, err);
    return text === t("common:errors.unknown") && err instanceof Error && err.message
      ? `${text} (${err.message.slice(0, 160)})`
      : text;
  };

  const read = async (files: PickedFile[]) => {
    setError(null);
    setDone(null);
    setResult(null);
    try {
      setResult(await upload.mutateAsync({ files: files.slice(0, MAX_FILES) }));
      setOn(ALL_ON);
    } catch (err) {
      haptics.error();
      setError(failure(err));
    }
  };

  const choose = async () => {
    if (!canPickFiles()) {
      setError(t("settings:data.chooseFileUnavailable"));
      setPasting(true);
      return;
    }
    let files: PickedFile[] | null;
    try {
      files = await pickImportFiles();
    } catch (err) {
      haptics.error();
      setError(failure(err));
      return;
    }
    if (files) await read(files);
  };

  const readText = async () => {
    if (!text.trim()) return;
    setError(null);
    setDone(null);
    setResult(null);
    try {
      setResult(await preview.mutateAsync(text));
      setOn(ALL_ON);
    } catch (err) {
      haptics.error();
      setError(failure(err));
    }
  };

  // Web: drop files anywhere on the pick area (React Native Web renders the View as a div).
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = drop.current as unknown as HTMLElement | null;
    if (!el?.addEventListener) return;
    const over = (e: DragEvent) => {
      e.preventDefault();
      setDragging(true);
    };
    const leave = () => setDragging(false);
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const files = [...(e.dataTransfer?.files ?? [])].map((file) => ({
        kind: "web" as const,
        file,
        name: file.name,
      }));
      if (files.length) void read(files);
    };
    el.addEventListener("dragover", over);
    el.addEventListener("dragleave", leave);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragover", over);
      el.removeEventListener("dragleave", leave);
      el.removeEventListener("drop", onDrop);
    };
    // read only uses state setters and stable mutations
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, done]);

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
          if (!(err instanceof PasskeyCancelledError)) setError(failure(err));
        }
      }
      haptics.success();
      setDone({ res, budgets });
      setResult(null);
      setText("");
    } catch (err) {
      haptics.error();
      setError(failure(err));
    }
  };

  const picker = (
    <View ref={drop}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("settings:importScreen.choose")}
        disabled={reading}
        onPress={() => void choose()}
        style={({ pressed }) => ({
          alignItems: "center",
          gap: 10,
          paddingVertical: 28,
          paddingHorizontal: 16,
          borderRadius: 20,
          borderWidth: 2,
          borderStyle: "dashed",
          borderColor: dragging ? colors.primary : colors.border,
          backgroundColor: dragging || pressed ? colors.muted : "transparent",
        })}
      >
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: 28,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.primary,
          }}
        >
          <Icon name="doc.text" fallback="description" size={26} color="primaryForeground" />
        </View>
        <Text weight="semibold" style={{ fontSize: 17, textAlign: "center" }}>
          {reading ? t("settings:data.reading") : t("settings:importScreen.choose")}
        </Text>
        <Text variant="caption" color="mutedForeground" style={{ textAlign: "center" }}>
          {Platform.OS === "web"
            ? t("settings:importScreen.dropHint")
            : t("settings:importScreen.pickHint")}
        </Text>
      </Pressable>
    </View>
  );

  return (
    <ScrollScreen>
      {!result && !done ? (
        <Box gap={4}>
          <Box gap={1}>
            <Text variant="title">{t("settings:importScreen.heroTitle")}</Text>
            <Text color="mutedForeground">{t("settings:importScreen.heroBody")}</Text>
          </Box>
          {picker}
          <Box gap={1}>
            <Text variant="caption" weight="semibold">
              {t("settings:importScreen.howTitle")}
            </Text>
            <Text variant="caption" color="mutedForeground">
              {t("settings:importScreen.how")}
            </Text>
          </Box>
          <Text variant="caption" color="mutedForeground">
            {t("settings:importScreen.privacy")}
          </Text>
          {pasting ? (
            <Box gap={2}>
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
                onPress={() => void readText()}
              >
                {t("settings:data.check")}
              </Button>
            </Box>
          ) : (
            <Button variant="ghost" size="sm" onPress={() => setPasting(true)}>
              {t("settings:importScreen.pasteToggle")}
            </Button>
          )}
        </Box>
      ) : null}

      {commit.isPending && result ? (
        <Text variant="caption">
          {t("settings:data.importing", {
            done: progress?.done ?? 0,
            count: progress?.total ?? result.items.transactions.length,
          })}
        </Text>
      ) : null}
      {result ? (
        <>
          <ImportPreviewCard
            result={result}
            on={on}
            setOn={setOn}
            onImport={() => void doImport()}
            busy={commit.isPending || setBudgets.isPending}
            importLabel={t("settings:data.import")}
            simple
          />
          <Button variant="ghost" disabled={commit.isPending} onPress={() => void choose()}>
            {t("settings:importScreen.another")}
          </Button>
        </>
      ) : null}

      {done ? (
        <Card>
          <Box gap={3}>
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
            <Button onPress={() => router.replace("/")}>
              {t("settings:importScreen.doneHome")}
            </Button>
            <Button variant="ghost" onPress={() => setDone(null)}>
              {t("settings:importScreen.more")}
            </Button>
          </Box>
        </Card>
      ) : null}
      {error ? <Text color="destructive">{error}</Text> : null}
    </ScrollScreen>
  );
}
