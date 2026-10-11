import { Stack } from "expo-router";

import { useKassaT } from "@/lib/i18n";
import { inlineTitleOptions, largeTitleOptions } from "@/navigation/stack-options";

export default function OnboardingLayout() {
  const t = useKassaT();
  return (
    <Stack>
      <Stack.Screen
        name="chat"
        options={{ ...inlineTitleOptions, title: t("onboarding:chatTitle") }}
      />
      <Stack.Screen
        name="review"
        options={{ ...largeTitleOptions, title: t("onboarding:reviewTitle") }}
      />
    </Stack>
  );
}
