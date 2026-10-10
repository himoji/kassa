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

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="+not-found" />
      {/* gen:stack */}
    </Stack>
  );
}
