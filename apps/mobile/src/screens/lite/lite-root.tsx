import * as SplashScreen from "expo-splash-screen";
import { Stack } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";

import { bootstrapSession } from "@/api/session";
import { ThemeProvider as UiThemeProvider, ToastHost, useTheme } from "@/components/ui";
import { I18nProvider, useKassaT } from "@/lib/i18n";
import { QueryProvider } from "@/lib/query";
import { registerApproveInWebApp } from "@/lite/approve";
import { applyServerUrl, loadServerUrl } from "@/lite/server-url";
import { useAppLock } from "@/lite/use-app-lock";
import { inlineTitleOptions } from "@/navigation/stack-options";
import { useSessionStore } from "@/stores/session";
import { hydrateThemeMode } from "@/stores/theme-mode";

import { LockScreen } from "./lock-screen";

SplashScreen.preventAutoHideAsync().catch(() => {});

/** The app's providers minus push (`PushProvider` registers for remote push, which lite cannot sign). */
function LiteProviders({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <UiThemeProvider>
        <I18nProvider>
          {children}
          <ToastHost />
        </I18nProvider>
      </UiThemeProvider>
    </QueryProvider>
  );
}

function LiteNavigator() {
  const t = useKassaT();
  const { colors } = useTheme();
  const status = useSessionStore((s) => s.status);
  const { locked, unlock } = useAppLock();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // The paired server must be set before the first request leaves the app.
      const server = await loadServerUrl();
      if (server) applyServerUrl(server);
      await Promise.all([bootstrapSession(), hydrateThemeMode()]);
      if (!cancelled) setReady(true);
    })();
    return registerApproveInWebApp();
  }, []);

  useEffect(() => {
    if (ready && status !== "loading") SplashScreen.hideAsync().catch(() => {});
  }, [ready, status]);

  if (!ready || status === "loading") return null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Protected guard={status === "authenticated"}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="order/[proposalId]"
            options={{
              presentation: "formSheet",
              sheetAllowedDetents: [0.8, 1],
              sheetGrabberVisible: true,
              sheetCornerRadius: 24,
            }}
          />
        </Stack.Protected>
        <Stack.Screen
          name="pair"
          options={{ ...inlineTitleOptions, headerShown: true, title: t("lite:pair.title") }}
        />
      </Stack>
      {/* Covers every screen while locked; the navigator below keeps its state. */}
      {locked ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
          <LockScreen onUnlock={() => void unlock()} />
        </View>
      ) : null}
    </View>
  );
}

/** Root of the KassaLite build (`src/app-lite/_layout.tsx`). */
export function LiteRoot() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <LiteProviders>
          <LiteNavigator />
        </LiteProviders>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
