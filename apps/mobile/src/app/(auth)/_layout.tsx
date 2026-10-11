import { Stack } from "expo-router";

import { useKassaT } from "@/lib/i18n";
import { largeTitleOptions } from "@/navigation/stack-options";

export default function AuthLayout() {
  const t = useKassaT();
  return (
    <Stack screenOptions={largeTitleOptions}>
      <Stack.Screen name="welcome" options={{ headerShown: false }} />
      <Stack.Screen name="register" options={{ title: t("auth:registerTitle") }} />
      <Stack.Screen name="login" options={{ title: t("auth:loginTitle") }} />
    </Stack>
  );
}
