import { Box, Button, Icon, Screen, Text } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";

/** Shown while KassaLite is locked: Face ID prompts on open and on resume; this button retries. */
export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const t = useKassaT();
  return (
    <Screen>
      <Box flex={1} align="center" justify="center" gap={4}>
        <Icon name="lock.fill" fallback="lock" size={48} color="mutedForeground" />
        <Text variant="title" align="center">
          {t("lite:lock.title")}
        </Text>
        <Text variant="caption" align="center">
          {t("lite:lock.body")}
        </Text>
        <Button onPress={onUnlock}>{t("lite:lock.unlock")}</Button>
      </Box>
    </Screen>
  );
}
