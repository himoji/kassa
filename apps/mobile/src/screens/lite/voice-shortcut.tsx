import { RowGroup } from "@/components/row-group";
import { VoiceShortcutSteps } from "@/components/kassa/voice-shortcut-steps";
import { Box, Button, Text, toast } from "@/components/ui";
import { copyToClipboard } from "@/lib/clipboard";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { loadServerUrl } from "@/lite/server-url";
import { voiceUrlWithKey } from "@/lite/shortcut-check";
import { loadShortcutToken } from "@/lite/shortcut-token";

/**
 * KassaLite → Settings → "Ask Kassa by voice": copies the voice Shortcut's one link (the paired Shortcut key in it,
 * only on this tap) and shows the steps. The answer is read-only: payments still need the app (capture/routes.ts).
 */
export function VoiceShortcut() {
  const t = useKassaT();
  const copy = async () => {
    const [token, server] = await Promise.all([loadShortcutToken(), loadServerUrl()]);
    if (!token || !server) {
      haptics.error();
      toast.show({ title: t("lite:settings.setup.noToken"), kind: "error" });
      return;
    }
    await copyToClipboard(voiceUrlWithKey(server, token), { toast: t("shortcut:voice.copied") });
    haptics.success();
  };
  return (
    <RowGroup title={t("shortcut:voice.title")} footer={t("shortcut:voice.footer")}>
      <Box p={4} gap={3}>
        <Text variant="caption">{t("shortcut:voice.intro")}</Text>
        <Button onPress={() => void copy()}>{t("shortcut:voice.copyLink")}</Button>
        <VoiceShortcutSteps />
      </Box>
    </RowGroup>
  );
}
