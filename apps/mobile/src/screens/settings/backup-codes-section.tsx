import { useState } from "react";
import { View } from "react-native";

import { useCreateRecoveryCodes, useRecoveryCodesStatus } from "@/api/hooks/auth";
import { RowGroup } from "@/components/row-group";
import { errorText } from "@/components/kassa/error-text";
import { Box, Button, Text } from "@/components/ui";
import { copyToClipboard } from "@/lib/clipboard";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { PasskeyCancelledError } from "@/lib/passkey-errors";

/** Backup codes for a lost passkey: how many are left, and a new set (passkey-gated) shown exactly once. */
export function BackupCodesSection() {
  const t = useKassaT();
  const status = useRecoveryCodesStatus();
  const create = useCreateRecoveryCodes();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setError(null);
    try {
      const res = await create.mutateAsync();
      haptics.success();
      setCodes(res.codes);
    } catch (err) {
      if (err instanceof PasskeyCancelledError) return;
      haptics.error();
      setError(errorText(t, err));
    }
  };

  const s = status.data;
  return (
    <RowGroup title={t("settings:backupCodes.title")} footer={t("settings:backupCodes.footer")}>
      <Box p={4} gap={3}>
        {codes ? (
          <>
            <Text weight="semibold">{t("settings:backupCodes.shownOnce")}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }} testID="backup-codes">
              {codes.map((c) => (
                <Text
                  key={c}
                  selectable
                  style={{ width: "46%", fontFamily: "monospace", fontVariant: ["tabular-nums"] }}
                >
                  {c}
                </Text>
              ))}
            </View>
            <Button
              variant="outline"
              onPress={() =>
                void copyToClipboard(codes.join("\n"), { toast: t("settings:backupCodes.copied") })
              }
            >
              {t("settings:backupCodes.copyAll")}
            </Button>
            <Button onPress={() => setCodes(null)}>{t("settings:backupCodes.done")}</Button>
          </>
        ) : (
          <>
            <Text variant="caption">
              {s && s.total > 0
                ? t("settings:backupCodes.status", { remaining: s.remaining, total: s.total })
                : t("settings:backupCodes.none")}
            </Text>
            <Button
              variant={s && s.total > 0 ? "outline" : "primary"}
              loading={create.isPending}
              onPress={() => void generate()}
            >
              {s && s.total > 0
                ? t("settings:backupCodes.regenerate")
                : t("settings:backupCodes.create")}
            </Button>
          </>
        )}
        {error ? <Text color="destructive">{error}</Text> : null}
      </Box>
    </RowGroup>
  );
}
