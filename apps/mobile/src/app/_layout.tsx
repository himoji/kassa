import { Stack, usePathname } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";

import { AnimatedSplashOverlay } from "@/components/animated-icon";
import { UpdatesBanner } from "@/components/updates-banner";
import { useAuthRedirect } from "@/hooks/use-auth-redirect";
import { useOnboardingRedirect } from "@/hooks/use-onboarding-redirect";
import { useSignOutCleanup } from "@/hooks/use-sign-out-cleanup";
import { analytics } from "@/lib/analytics";
import { useKassaT } from "@/lib/i18n";
import { inlineTitleOptions, largeTitleOptions } from "@/navigation/stack-options";
import { Providers } from "@/providers";
import { hydrateThemeMode } from "@/stores/theme-mode";

export { ErrorBoundary } from "@/components/error-boundary";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  useEffect(() => {
    // Single hydration point: the theme provider only reads the store.
    hydrateThemeMode().finally(() => {
      SplashScreen.hideAsync().catch((err: unknown) => {
        console.warn("[splash] hideAsync failed", err);
      });
    });
  }, []);

  // Gesture handler: native press handling (`@/components/ui` Pressable, sheets). Keyboard provider:
  // the keyboard-aware scrolling behind `<Screen scroll>`. Both wrap everything, once.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <Providers>
          <AnimatedSplashOverlay />
          <UpdatesBanner />
          <RootStack />
        </Providers>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

/** Inside `Providers` so redirect hooks can read stores/providers; routes come from `src/app`. */
function RootStack() {
  useOnboardingRedirect();
  useAuthRedirect();
  useSignOutCleanup();

  const pathname = usePathname();
  useEffect(() => {
    analytics.screen(pathname);
  }, [pathname]);

  const t = useKassaT();

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="onboarding" />
      <Stack.Screen name="(tabs)" />
      {/* Confirmation sheet (spec §16): native form sheet with detents (UISheetPresentationController /
          Material bottom sheet). Renders only the server's canonical order. */}
      <Stack.Screen
        name="order/[proposalId]"
        options={{
          presentation: "formSheet",
          sheetAllowedDetents: [0.8, 1],
          sheetGrabberVisible: true,
          sheetCornerRadius: 24,
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="payees/index"
        options={{ ...largeTitleOptions, headerShown: true, title: t("payees:title") }}
      />
      <Stack.Screen
        name="payees/[id]"
        options={{ ...inlineTitleOptions, headerShown: true, title: t("payees:detailTitle") }}
      />
      <Stack.Screen
        name="purchase/[id]"
        options={{ ...inlineTitleOptions, headerShown: true, title: t("insights:detail.title") }}
      />
      <Stack.Screen
        name="insights"
        options={{ ...largeTitleOptions, headerShown: true, title: t("insights:title") }}
      />
      <Stack.Screen
        name="bills/index"
        options={{ ...largeTitleOptions, headerShown: true, title: t("bills:title") }}
      />
      {/* Mandatory backup codes (use-require-backup-codes.ts): no swipe-down, no back, until a set is saved. */}
      <Stack.Screen
        name="backup-codes"
        options={{
          presentation: "fullScreenModal",
          gestureEnabled: false,
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="credit-record"
        options={{ ...largeTitleOptions, headerShown: true, title: t("credit:title") }}
      />
      <Stack.Screen
        name="data"
        options={{ ...largeTitleOptions, headerShown: true, title: t("settings:data.title") }}
      />
      <Stack.Screen
        name="shortcut"
        options={{ ...largeTitleOptions, headerShown: true, title: t("shortcut:title") }}
      />
      <Stack.Screen
        name="pair-lite"
        options={{ ...inlineTitleOptions, headerShown: true, title: t("lite:pairDevice.title") }}
      />
      <Stack.Screen
        name="verify/[id]"
        options={{ ...largeTitleOptions, headerShown: true, title: t("credit:verifyTitle") }}
      />
      <Stack.Screen
        name="pay/[billId]"
        options={{ ...inlineTitleOptions, headerShown: true, title: t("shop:pay.title") }}
      />
      <Stack.Screen
        name="handoff/[paymentId]"
        options={{ ...inlineTitleOptions, headerShown: true, title: t("handoff:title") }}
      />
      <Stack.Screen
        name="demo"
        options={{
          ...inlineTitleOptions,
          headerShown: true,
          presentation: "modal",
          title: t("demo:title"),
        }}
      />
      <Stack.Screen
        name="add-money"
        options={{
          ...inlineTitleOptions,
          headerShown: true,
          presentation: "modal",
          title: t("wallet:addTitle"),
        }}
      />
      <Stack.Screen
        name="linked-accounts"
        options={{ ...largeTitleOptions, headerShown: true, title: t("wallet:linked.title") }}
      />
      <Stack.Screen
        name="send"
        options={{ ...inlineTitleOptions, headerShown: true, title: t("wallet:sendTitle") }}
      />
      <Stack.Screen name="+not-found" />
      {/* gen:stack */}
    </Stack>
  );
}
