/**
 * Web app pages opened from KassaLite (`?from=lite`: a passkey step Lite cannot do, src/lite/approve.ts) show a bar
 * to go back to KassaLite. Going back closes the in-app browser sheet (its auth session waits for `kassalite://`).
 * Renders nothing elsewhere, and nothing on native (the full app is never opened from Lite).
 */
import { useGlobalSearchParams, usePathname } from "expo-router";
import { useState } from "react";
import { Linking, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Box, Button, Text } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";
import { LITE_RETURN_URL } from "@/lite/approve";

export function LiteReturnBar() {
  const t = useKassaT();
  const insets = useSafeAreaInsets();
  const params = useGlobalSearchParams<{ from?: string }>();
  const pathname = usePathname();
  // Remembered for the visit: sign-in in between drops the query, the person still came from KassaLite.
  const [fromLite, setFromLite] = useState(false);
  if (params.from === "lite" && !fromLite) setFromLite(true);
  if (Platform.OS !== "web" || !fromLite) return null;
  const path = pathname.replace(/^\//, "");
  return (
    <Box
      row
      align="center"
      justify="between"
      gap={2}
      px={4}
      py={2}
      bg="muted"
      style={{ paddingTop: insets.top + 8 }}
    >
      <Text variant="caption" style={{ flexShrink: 1 }}>
        {t("lite:returnBar.text")}
      </Text>
      <Button
        size="sm"
        variant="secondary"
        onPress={() => void Linking.openURL(`${LITE_RETURN_URL}${path}`).catch(() => {})}
      >
        {t("lite:returnBar.back")}
      </Button>
    </Box>
  );
}
