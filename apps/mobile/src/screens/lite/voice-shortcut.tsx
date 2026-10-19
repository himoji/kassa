import { AddShortcutButton } from "@/components/kassa/add-shortcut-button";
import { RowGroup } from "@/components/row-group";
import { VoiceShortcutSteps } from "@/components/kassa/voice-shortcut-steps";
import { Box, Button, Text, toast } from "@/components/ui";
import { copyToClipboard } from "@/lib/clipboard";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { loadServerUrl } from "@/lite/server-url";
import { readyVoiceShortcutLink, voiceUrlWithKey } from "@/lite/shortcut-check";
import { loadShortcutToken } from "@/lite/shortcut-token";

/**
 * KassaLite → Settings → "Apple Pay & Siri" → "Ask Kassa by voice": copies the voice Shortcut's one link (the
 * paired Shortcut key in it, only on this tap) and shows the steps; with the published Shortcut's iCloud link in the
 * bundle, "Add" copies the same link and opens the Shortcut instead, whose import question takes it. The answer is
 * read-only: payments still need the app (capture/routes.ts).
 */
export function VoiceShortcut() {
  const t = useKassaT();
  const readyLink = readyVoiceShortcutLink();
  const keyedLink = async () => {
    const [token, server] = await Promise.all([loadShortcutToken(), loadServerUrl()]);
    return token && server ? voiceUrlWithKey(server, token) : null;
  };
  const copy = async () => {
    const link = await keyedLink();
    if (!link) {
      haptics.error();
      toast.show({ title: t("lite:settings.setup.noToken"), kind: "error" });
      return;
    }
    await copyToClipboard(link, { toast: t("shortcut:voice.copied") });
    haptics.success();
  };
  return (
    <RowGroup title={t("shortcut:voice.title")} footer={t("shortcut:voice.footer")}>
      <Box p={4} gap={3}>
        <Text variant="caption">{t("shortcut:voice.intro")}</Text>
        {readyLink ? (
          <AddShortcutButton
            link={readyLink}
            pasteValue={keyedLink}
            label={t("shortcut:voice.add")}
            after={t("shortcut:voice.after")}
          />
        ) : (
          <>
            <Button onPress={() => void copy()}>{t("shortcut:voice.copyLink")}</Button>
            <VoiceShortcutSteps />
          </>
        )}
      </Box>
    </RowGroup>
  );
}
