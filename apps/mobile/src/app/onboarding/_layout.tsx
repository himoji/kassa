import { Stack } from "expo-router";

import { useKassaT } from "@/lib/i18n";
import { inlineTitleOptions } from "@/navigation/stack-options";

export default function OnboardingLayout() {
  const t = useKassaT();
  return (
    <Stack>
      <Stack.Screen
        name="chat"
        options={{ ...inlineTitleOptions, title: t("onboarding:chatTitle") }}
      />
      {/* Review + sign (spec §16): a form sheet over the chat, like the order sheet in the root layout. */}
      <Stack.Screen
        name="review"
        options={{
          presentation: "formSheet",
          sheetAllowedDetents: [0.8, 1],
          sheetGrabberVisible: true,
          sheetCornerRadius: 24,
          headerShown: false,
          title: t("onboarding:reviewTitle"),
        }}
      />
    </Stack>
  );
}
