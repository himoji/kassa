import { Stack } from "expo-router";

import { useKassaT } from "@/lib/i18n";
import { largeTitleOptions } from "@/navigation/stack-options";

export default function Layout() {
  const t = useKassaT();
  return (
    <Stack screenOptions={largeTitleOptions}>
      <Stack.Screen name="index" options={{ title: t("insights:title") }} />
    </Stack>
  );
}
