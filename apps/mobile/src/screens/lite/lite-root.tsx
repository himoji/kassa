import * as SplashScreen from "expo-splash-screen";
import { Stack } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";

import { bootstrapSession } from "@/api/session";
import { ThemeProvider as UiThemeProvider, ToastHost, useTheme } from "@/components/ui";
import { UpdatesBanner } from "@/components/updates-banner";
import { useLiveFeed } from "@/hooks/use-live-feed";
import { I18nProvider, useKassaT } from "@/lib/i18n";
import { QueryProvider } from "@/lib/query";
import { registerApproveInWebApp } from "@/lite/approve";
import { syncIntentConfig } from "@/lite/intent-config";
import { applyServerUrl, loadServerUrl } from "@/lite/server-url";
import { useNotificationLinks } from "@/lite/notifier";
import { useAppLock } from "@/lite/use-app-lock";
import { inlineTitleOptions, largeTitleOptions } from "@/navigation/stack-options";
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
  // A tapped purchase notification opens that purchase, once the navigator is up and the phone is paired.
  useNotificationLinks(ready && status === "authenticated");
  // Money someone sends shows up (banner, balances, lists) while the app is open, without a pull.
  useLiveFeed(ready);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // The paired server must be set before the first request leaves the app.
      const server = await loadServerUrl();
      if (server) applyServerUrl(server);
      // Pairings made before the Log Payment action existed get its Keychain copy here.
      void syncIntentConfig();
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
      {/* A downloaded over-the-air update otherwise waits for the next cold start. */}
      <UpdatesBanner />
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
          {/* The full app's screens (docs/guide/kassalite.md "What is in it"); approving and other passkey steps open the
              web app (428 approveInWebApp). */}
          <Stack.Screen
            name="payees/index"
            options={{ ...largeTitleOptions, headerShown: true, title: t("payees:title") }}
          />
          <Stack.Screen
            name="payees/new"
            options={{
              ...inlineTitleOptions,
              headerShown: true,
              presentation: "modal",
              title: t("payees:add.title"),
            }}
          />
          <Stack.Screen
            name="payees/[id]"
            options={{ ...inlineTitleOptions, headerShown: true, title: t("payees:detailTitle") }}
          />
          <Stack.Screen
            name="bills/index"
            options={{ ...largeTitleOptions, headerShown: true, title: t("bills:title") }}
          />
          <Stack.Screen
            name="send"
            options={{ ...inlineTitleOptions, headerShown: true, title: t("wallet:sendTitle") }}
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
            name="convert"
            options={{
              ...inlineTitleOptions,
              headerShown: true,
              title: t("wallet:convert.title"),
            }}
          />
          <Stack.Screen
            name="cards"
            options={{ ...largeTitleOptions, headerShown: true, title: t("cards:title") }}
          />
          <Stack.Screen
            name="credit-record"
            options={{ ...largeTitleOptions, headerShown: true, title: t("credit:title") }}
          />
          <Stack.Screen
            name="verify/[id]"
            options={{ ...largeTitleOptions, headerShown: true, title: t("credit:verifyTitle") }}
          />
          <Stack.Screen
            name="data"
            options={{ ...largeTitleOptions, headerShown: true, title: t("settings:data.title") }}
          />
          <Stack.Screen
            name="import"
            options={{
              ...inlineTitleOptions,
              headerShown: true,
              title: t("settings:importScreen.title"),
            }}
          />
          <Stack.Screen
            name="linked-accounts"
            options={{ ...largeTitleOptions, headerShown: true, title: t("wallet:linked.title") }}
          />
          <Stack.Screen
            name="shortcut-test"
            options={{ ...inlineTitleOptions, headerShown: true, title: t("shortcut:test.title") }}
          />
          <Stack.Screen
            name="shortcut"
            options={{
              ...inlineTitleOptions,
              headerShown: true,
              title: t("lite:settings.siriTitle"),
            }}
          />
          <Stack.Screen
            name="demo"
            options={{ ...inlineTitleOptions, headerShown: true, title: t("evidence:links.title") }}
          />
          <Stack.Screen
            name="evidence"
            options={{ ...inlineTitleOptions, headerShown: true, title: t("evidence:title") }}
          />
          <Stack.Screen
            name="identity-check"
            options={{ ...largeTitleOptions, headerShown: true, title: t("kyc:title") }}
          />
          <Stack.Screen
            name="handoff/[paymentId]"
            options={{ ...inlineTitleOptions, headerShown: true, title: t("handoff:title") }}
          />
          <Stack.Screen
            name="pay/[billId]"
            options={{ ...inlineTitleOptions, headerShown: true, title: t("shop:pay.title") }}
          />
          <Stack.Screen
            name="insights"
            options={{ ...largeTitleOptions, headerShown: true, title: t("insights:title") }}
          />
          <Stack.Screen
            name="purchase/[id]"
            options={{
              ...inlineTitleOptions,
              headerShown: true,
              title: t("insights:detail.title"),
            }}
          />
        </Stack.Protected>
        <Stack.Screen
          name="pair"
          options={{ ...inlineTitleOptions, headerShown: true, title: t("lite:pair.title") }}
        />
        <Stack.Screen name="+not-found" />
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
