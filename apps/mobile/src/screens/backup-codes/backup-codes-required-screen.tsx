import { router } from "expo-router";
import { useEffect } from "react";
import { BackHandler } from "react-native";

import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Box, Card, Icon, Text } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";
import { BackupCodesPanel } from "@/screens/settings/backup-codes-section";

/**
 * Backup codes are mandatory: Home sends every account without unused codes here (use-require-backup-codes.ts), and
 * the only way out is a new set the user confirmed they saved. A lost passkey without codes is a locked account.
 */
export function BackupCodesRequiredScreen() {
  const t = useKassaT();
  useEffect(() => {
    // Android back button: stay until the codes are saved.
    const sub = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => sub.remove();
  }, []);
  return (
    <ScrollScreen testID="backup-codes-required">
      <Box gap={3}>
        <Icon name="key.fill" fallback="key" size={32} color="brandAccent" />
        <Text variant="title">{t("settings:backupCodes.requiredTitle")}</Text>
        <Text variant="caption">{t("settings:backupCodes.requiredBody")}</Text>
      </Box>
      <Card>
        <BackupCodesPanel
          required
          onDone={() => (router.canGoBack() ? router.back() : router.replace("/home"))}
        />
      </Card>
      <Text variant="caption">{t("settings:backupCodes.footer")}</Text>
    </ScrollScreen>
  );
}
