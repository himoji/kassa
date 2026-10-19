import { Stack } from "expo-router";

import { useKassaT } from "@/lib/i18n";
import { inlineTitleOptions, largeTitleOptions } from "@/navigation/stack-options";

/** A link straight to a detail (Home's "Edit budgets" → /settings/budgets) still has the Settings list to go back to. */
export const unstable_settings = { initialRouteName: "index" };

export default function SettingsLayout() {
  const t = useKassaT();
  return (
    <Stack screenOptions={largeTitleOptions}>
      <Stack.Screen name="index" options={{ title: t("settings:title") }} />
      <Stack.Screen
        name="preset"
        options={{ ...inlineTitleOptions, title: t("settings:presetTitle") }}
      />
      <Stack.Screen
        name="limits"
        options={{ ...inlineTitleOptions, title: t("settings:capsTitle") }}
      />
      <Stack.Screen
        name="mandates"
        options={{ ...inlineTitleOptions, title: t("settings:mandates.title") }}
      />
      <Stack.Screen
        name="budgets"
        options={{ ...inlineTitleOptions, title: t("settings:budgets.title") }}
      />
      <Stack.Screen
        name="security"
        options={{ ...inlineTitleOptions, title: t("settings:backupCodes.title") }}
      />
      <Stack.Screen
        name="appearance"
        options={{ ...inlineTitleOptions, title: t("settings:root.appearanceLanguageTitle") }}
      />
      <Stack.Screen
        name="demo-proof"
        options={{ ...inlineTitleOptions, title: t("evidence:links.title") }}
      />
    </Stack>
  );
}
