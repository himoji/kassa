import { Stack } from "expo-router";

import { useKassaT } from "@/lib/i18n";
import { inlineTitleOptions } from "@/navigation/stack-options";

export default function Layout() {
  const t = useKassaT();
  return (
    <Stack screenOptions={inlineTitleOptions}>
      <Stack.Screen name="index" options={{ title: t("lite:activity.title") }} />
    </Stack>
  );
}
