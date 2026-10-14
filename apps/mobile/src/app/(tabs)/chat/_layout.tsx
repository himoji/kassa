import { Stack } from "expo-router";

import { useKassaT } from "@/lib/i18n";
import { inlineTitleOptions, largeTitleOptions } from "@/navigation/stack-options";

export default function ChatLayout() {
  const t = useKassaT();
  return (
    <Stack screenOptions={inlineTitleOptions}>
      <Stack.Screen name="index" options={{ title: t("chat:title") }} />
      <Stack.Screen
        name="history"
        options={{ ...largeTitleOptions, title: t("chat:history.title") }}
      />
    </Stack>
  );
}
