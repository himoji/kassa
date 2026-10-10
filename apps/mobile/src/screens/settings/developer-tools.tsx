/**
 * Settings → Developer tools: shortcuts for checking what this build does. `SettingsScreen`
 * renders it only when `__DEV__`, so release builds never ship it on screen.
 *
 * Every row goes through a core contract or flag (`@/lib/*`, `@/hooks/*`), never a module
 * import, so the file compiles with any selection: a row whose module is not selected is
 * not rendered (`payments.presentPaywall`, `auth.openSignIn` and `push.sendTestNotification`
 * are optional contract methods; `onboardingEnabled` and `consentEnabled` are flags).
 */
import Constants from "expo-constants";
import { router } from "expo-router";
import * as Updates from "expo-updates";
import { useState } from "react";
import { Platform } from "react-native";

import { RowGroup } from "@/components/row-group";
import { onboardingEnabled } from "@/hooks/use-onboarding-redirect";
import { auth } from "@/lib/auth";
import { consent, consentEnabled } from "@/lib/consent";
import { crash } from "@/lib/crash";
import { env, envPresence } from "@/lib/env";
import { useT, type TFn } from "@/lib/i18n";
import { payments } from "@/lib/payments";
import { privacyCategories } from "@/lib/privacy-categories";
import { push } from "@/lib/push";
import { resetOnboarding } from "@/stores/onboarding";
import { Icon, Row, Text, toast } from "@/components/ui";

/** Seconds until the test notification fires. Matches the "Notification in 3 s" toast. */
const TEST_NOTIFICATION_DELAY = 3;

interface ToolRow {
  key: string;
  title: string;
  subtitle?: string;
  /** SF Symbol + its Material counterpart. */
  icon: string;
  fallback: string;
  destructive?: boolean;
  onPress: () => void;
}

function RowIcon({ name, fallback }: { name: string; fallback: string }) {
  return <Icon name={name} fallback={fallback} size={22} color="mutedForeground" />;
}

/** Throws while rendering, so the route `ErrorBoundary` (and a crash module) sees a real render error. */
function ThrowOnRender(): null {
  throw new Error("Test crash from Settings → Developer tools");
}

async function previewPaywall(t: TFn): Promise<void> {
  try {
    await payments.presentPaywall?.();
  } catch (err) {
    crash.capture(err, { where: "developer-tools.paywall" });
    toast.show({ title: t("Could not open the paywall"), kind: "error" });
  }
}

async function sendTestNotification(t: TFn): Promise<void> {
  try {
    const sent = await push.sendTestNotification?.(
      { title: t("Test notification"), body: t("Sent from Developer tools.") },
      TEST_NOTIFICATION_DELAY
    );
    toast.show(
      sent ? { title: t("Notification in 3 s") } : { title: t("Permission denied"), kind: "error" }
    );
  } catch (err) {
    crash.capture(err, { where: "developer-tools.notification" });
    toast.show({ title: t("Could not schedule the notification"), kind: "error" });
  }
}

/** iOS `buildNumber` / Android `versionCode` from the app config; absent with EAS remote versions. */
function buildNumber(): string | undefined {
  const config = Constants.expoConfig;
  const value = Platform.OS === "android" ? config?.android?.versionCode : config?.ios?.buildNumber;
  return value === undefined || value === null ? undefined : String(value);
}

function toolRows(t: TFn, signedIn: boolean, crashNow: () => void): ToolRow[] {
  const rows: ToolRow[] = [
    {
      key: "sitemap",
      title: t("Page map"),
      icon: "map",
      fallback: "map",
      // Expo Router's built-in route list (`/_sitemap`).
      onPress: () => router.push("/_sitemap"),
    },
  ];
  if (onboardingEnabled) {
    rows.push({
      key: "onboarding",
      title: t("Replay onboarding"),
      icon: "play.rectangle",
      fallback: "slideshow",
      // `useOnboardingRedirect()` sends an unfinished onboarding to `/onboarding`.
      onPress: resetOnboarding,
    });
  }
  if (consentEnabled && privacyCategories.length > 0) {
    rows.push({
      key: "consent",
      title: t("Show consent sheet"),
      icon: "checkmark.shield",
      fallback: "verified_user",
      onPress: () => consent.reprompt(),
    });
  }
  if (payments.presentPaywall) {
    rows.push({
      key: "paywall",
      title: t("Preview paywall"),
      icon: "creditcard",
      fallback: "credit_card",
      onPress: () => void previewPaywall(t),
    });
  }
  if (auth.openSignIn) {
    rows.push({
      key: "sign-in",
      title: t("Open sign-in"),
      subtitle: signedIn ? t("Signed in: sign out first to see it") : undefined,
      icon: "person.crop.circle",
      fallback: "login",
      onPress: () => auth.openSignIn?.(),
    });
  }
  if (push.sendTestNotification) {
    rows.push({
      key: "notification",
      title: t("Send test notification"),
      icon: "bell.badge",
      fallback: "notifications_active",
      onPress: () => void sendTestNotification(t),
    });
  }
  rows.push({
    key: "crash",
    title: t("Trigger a crash"),
    subtitle: t("Throws during render: shows the error screen and reports the crash"),
    icon: "exclamationmark.triangle",
    fallback: "warning",
    destructive: true,
    onPress: crashNow,
  });
  return rows;
}

export function DeveloperTools() {
  const t = useT();
  const session = auth.useSession();
  const [crashing, setCrashing] = useState(false);
  const rows = toolRows(t, session.status === "authenticated", () => setCrashing(true));

  const info: { key: string; title: string; value: string }[] = [
    { key: "version", title: t("Version"), value: Constants.expoConfig?.version ?? t("unknown") },
    { key: "build", title: t("Build"), value: buildNumber() ?? t("Not in app config") },
    { key: "variant", title: t("Variant"), value: env.APP_VARIANT },
    { key: "runtime", title: t("Runtime version"), value: Updates.runtimeVersion ?? t("None") },
    { key: "update", title: t("Update"), value: Updates.updateId ?? t("None") },
  ];

  return (
    <>
      {crashing ? <ThrowOnRender /> : null}

      <RowGroup title={t("Developer tools")} icons>
        {rows.map((row) => (
          <Row
            key={row.key}
            title={row.title}
            subtitle={row.subtitle}
            leading={<RowIcon name={row.icon} fallback={row.fallback} />}
            destructive={row.destructive}
            chevron={false}
            onPress={row.onPress}
            testID={`developer-tools-${row.key}`}
          />
        ))}
      </RowGroup>

      <RowGroup
        title={t("Environment")}
        footer={t("The EXPO_PUBLIC_* keys this build reads. Values are never shown.")}
      >
        {envPresence.map((entry) => (
          <Row
            key={entry.key}
            title={entry.key}
            trailing={
              <Text variant="caption" color={entry.set ? "success" : "destructive"}>
                {entry.set ? t("Set") : t("Missing")}
              </Text>
            }
          />
        ))}
      </RowGroup>

      <RowGroup title={t("App info")}>
        {info.map((item) => (
          <Row
            key={item.key}
            title={item.title}
            trailing={
              <Text variant="caption" numberOfLines={1} style={{ flexShrink: 1, maxWidth: "60%" }}>
                {item.value}
              </Text>
            }
          />
        ))}
      </RowGroup>
    </>
  );
}
