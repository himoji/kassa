import { useState } from "react";
import { View } from "react-native";

import { useCreateRecoveryCodes, useRecoveryCodesStatus } from "@/api/hooks/auth";
import { RowGroup } from "@/components/row-group";
import { errorText } from "@/components/kassa/error-text";
import { SettingSwitch } from "@/components/kassa/native-controls";
import { Box, Button, Text } from "@/components/ui";
import { copyToClipboard } from "@/lib/clipboard";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { PasskeyCancelledError } from "@/lib/passkey-errors";

/**
 * Create backup codes (passkey-gated) and show the new set exactly once. `required`: the mandatory step after sign-up
 * (app/backup-codes.tsx): no way out until a set exists and the user confirms they saved it.
 */
export function BackupCodesPanel({
  required,
  onDone,
}: {
  required?: boolean;
  /** Called once the user confirmed they saved the new codes. */
  onDone?: () => void;
}) {
  const t = useKassaT();
  const status = useRecoveryCodesStatus();
  const create = useCreateRecoveryCodes();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setError(null);
    try {
      const res = await create.mutateAsync();
      haptics.success();
      setSaved(false);
      setCodes(res.codes);
    } catch (err) {
      if (err instanceof PasskeyCancelledError) return;
      haptics.error();
      setError(errorText(t, err));
    }
  };

  const s = status.data;
  const has = !!s && s.remaining > 0;
  return (
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
          {required ? (
            <View style={{ marginHorizontal: -16 }}>
              <SettingSwitch
                label={t("settings:backupCodes.savedConfirm")}
                value={saved}
                onChange={setSaved}
              />
            </View>
          ) : null}
          <Button
            disabled={required && !saved}
            onPress={() => {
              setCodes(null);
              onDone?.();
            }}
          >
            {t("settings:backupCodes.done")}
          </Button>
        </>
      ) : (
        <>
          <Text variant="caption">
            {s && s.total > 0
              ? t("settings:backupCodes.status", { remaining: s.remaining, total: s.total })
              : t("settings:backupCodes.none")}
          </Text>
          <Button
            variant={has ? "outline" : "primary"}
            loading={create.isPending}
            onPress={() => void generate()}
          >
            {has ? t("settings:backupCodes.regenerate") : t("settings:backupCodes.create")}
          </Button>
        </>
      )}
      {error ? <Text color="destructive">{error}</Text> : null}
    </Box>
  );
}

/** Settings: how many codes are left, and a new set. */
export function BackupCodesSection() {
  const t = useKassaT();
  return (
    <RowGroup title={t("settings:backupCodes.title")} footer={t("settings:backupCodes.footer")}>
      <BackupCodesPanel />
    </RowGroup>
  );
}
