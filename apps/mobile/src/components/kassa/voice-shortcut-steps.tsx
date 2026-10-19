import { Box, Text } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";

const STEPS = ["1", "2", "3", "4", "5", "6"] as const;

/** How to build the "Ask Kassa" voice Shortcut (POST /api/capture/voice, docs/guide/shortcuts.md "Voice"). */
export function VoiceShortcutSteps() {
  const t = useKassaT();
  return (
    <Box gap={2}>
      {STEPS.map((n) => (
        <Text key={n} variant="caption">
          {t("shortcut:step", { n, text: t(`shortcut:voice.steps.${n}`) })}
        </Text>
      ))}
    </Box>
  );
}
