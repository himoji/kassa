import { Stack } from "expo-router";

import { useKassaT } from "@/lib/i18n";
import { largeTitleOptions } from "@/navigation/stack-options";

export default function AuthLayout() {
  const t = useKassaT();
  return (
    <Stack screenOptions={largeTitleOptions}>
      {/* Full window width on web (not the 792px column): wide windows get the two-column welcome. */}
      <Stack.Screen
        name="welcome"
        options={{ headerShown: false, contentStyle: { width: "100%" } }}
      />
      <Stack.Screen name="register" options={{ title: t("auth:registerTitle") }} />
      <Stack.Screen name="login" options={{ title: t("auth:loginTitle") }} />
    </Stack>
  );
}
