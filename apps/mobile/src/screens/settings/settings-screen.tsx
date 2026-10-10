import Constants from "expo-constants";

import { usePasswordPrompt, type AskPasswordOptions } from "@/components/password-prompt";
import { RowGroup } from "@/components/row-group";
import { onboardingEnabled } from "@/hooks/use-onboarding-redirect";
import { deleteServerData } from "@/lib/account-data";
import { analytics } from "@/lib/analytics";
import { auth, type AuthUser } from "@/lib/auth";
import { openUrl } from "@/lib/browser";
import { confirm } from "@/lib/confirm";
import { consent, consentEnabled } from "@/lib/consent";
import { crash } from "@/lib/crash";
import { payments } from "@/lib/payments";
import { exportLocalData, shareDataExport, wipeLocalData } from "@/lib/privacy";
import { privacyCategories } from "@/lib/privacy-categories";
import { readynative } from "@/lib/readynative";
import {
  LANGUAGES,
  LANGUAGE_LABELS,
  isRTL,
  setLanguage,
  useLanguage,
  useT,
  type Language,
  type TFn,
} from "@/lib/i18n";
import { openStoreListing, storeListingUrl, trackSignificantEvent } from "@/lib/store-review";
import { DeveloperTools } from "@/screens/settings/developer-tools";
import { useConsentState, type ConsentCategory } from "@/stores/consent";
import { resetOnboarding } from "@/stores/onboarding";
import {
  Box,
  Button,
  Icon,
  Row,
  Screen,
  Switch,
  Text,
  setThemeMode,
  toast,
  useResolvedMode,
  useThemeMode,
  type ThemeMode,
} from "@/components/ui";

const MODES: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

type LinkRow = {
  key: keyof typeof readynative.urls;
  label: string;
  /** SF Symbol + its Material counterpart; `Row` only auto-renders the SF name. */
  icon: string;
  fallback: string;
};

const LINKS: LinkRow[] = [
  { key: "website", label: "Website", icon: "globe", fallback: "language" },
  { key: "support", label: "Support", icon: "lifepreserver", fallback: "support_agent" },
  { key: "privacy", label: "Privacy policy", icon: "lock.shield", fallback: "privacy_tip" },
  { key: "terms", label: "Terms of service", icon: "doc.text", fallback: "description" },
];

// Widened so the picker keeps compiling when `LANGUAGES` holds a single locale (`--i18n none`).
const languages: readonly Language[] = LANGUAGES;

function RowIcon({ name, fallback }: { name: string; fallback: string }) {
  return <Icon name={name} fallback={fallback} size={22} color="mutedForeground" />;
}

function isUsableUrl(url: string): boolean {
  return url.length > 0 && url !== "mailto:";
}

/** The root layout's `useSignOutCleanup` wipes local data on every sign-out. */
function signOut(): void {
  auth.signOut().catch((err: unknown) => {
    crash.capture(err, { where: "settings.signOut" });
  });
}

/** `my-data-<date>.json`: local data minus credentials, plus the account profile. */
async function exportData(t: TFn, user: AuthUser | null): Promise<void> {
  try {
    const json = await exportLocalData({ user });
    await shareDataExport(json, { title: t("My data") });
  } catch (err) {
    crash.capture(err, { where: "settings.exportData" });
    toast.show({ title: t("Could not export data"), kind: "error" });
  }
}

const CATEGORY_ROWS: Record<ConsentCategory, { title: string; icon: string; fallback: string }> = {
  analytics: { title: "Analytics", icon: "chart.bar", fallback: "bar_chart" },
  crash: { title: "Crash reports", icon: "ant", fallback: "bug_report" },
};

function errorCode(err: unknown): unknown {
  return typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
}

/** Derived, not imported: every auth module's `deleteAccount` takes it, not all export the type. */
type DeleteAccountOptions = Parameters<typeof auth.deleteAccount>[0];

/**
 * The optional pre-flight of the auth contract, typed locally: auth modules that declare their
 * own `Auth` interface (Supabase) may not list it yet.
 */
type DeletePreflight = { prepareDeleteAccount?(options?: DeleteAccountOptions): Promise<void> };

/** What a failed deletion step means for the flow. */
type DeleteOutcome = "retry-with-password" | "retry-wrong-password" | "sign-in-again" | "failed";

function outcomeOf(err: unknown): DeleteOutcome {
  const code = errorCode(err);
  if (code === "REAUTH_REQUIRED") return "retry-with-password";
  if (code === "INVALID_PASSWORD") return "retry-wrong-password";
  if (code === "SIGN_IN_AGAIN") return "sign-in-again";
  return "failed";
}

/**
 * Confirm, then delete in an order where nothing is erased until the provider will accept the
 * deletion:
 *   a. `auth.prepareDeleteAccount` - re-authentication (password) or "deletion is off";
 *   b. analytics flushes and stops, the store SDK logs out - nothing re-creates the person;
 *   c. `deleteServerData()` erases the user at the server's third-party services;
 *   d. `auth.deleteAccount()`;
 *   e. local data is wiped (`useSignOutCleanup` also runs on the sign-out that follows).
 * A cancelled password prompt or a refusal in (a) leaves everything as it was.
 */
async function deleteAccount(
  t: TFn,
  askPassword: (opts?: AskPasswordOptions) => Promise<string | null>
): Promise<void> {
  const ok = await confirm({
    title: t("Delete account"),
    message: t("This permanently deletes your account and its data."),
    confirmLabel: t("Delete"),
    cancelLabel: t("Cancel"),
    destructive: true,
  });
  if (!ok) return;

  const fail = (err: unknown): void => {
    // The reason (a missing migration, a dashboard switch) is for you, not for users.
    console.warn("[settings] delete account failed:", err instanceof Error ? err.message : err);
    crash.capture(err, { where: "settings.deleteAccount" });
    toast.show({ title: t("Could not delete account"), kind: "error" });
  };
  /** The password to retry with, or `null` when the flow stops here (cancelled or failed). */
  const handle = async (err: unknown): Promise<string | null> => {
    const outcome = outcomeOf(err);
    if (outcome === "retry-with-password" || outcome === "retry-wrong-password") {
      return askPassword({ retry: outcome === "retry-wrong-password" });
    }
    if (outcome === "sign-in-again") {
      toast.show({
        title: t("Sign in again to delete your account"),
        description: t("For your security, deleting needs a recent sign-in."),
        kind: "error",
      });
    } else {
      fail(err);
    }
    return null;
  };

  let options: DeleteAccountOptions | undefined;
  for (;;) {
    // a. Will the provider accept it? Nothing has been touched yet.
    try {
      await (auth as DeletePreflight).prepareDeleteAccount?.(options);
    } catch (err) {
      const password = await handle(err);
      if (password === null) return;
      options = { password };
      continue;
    }
    // b. + c. + d.
    try {
      await analytics.suspend();
      await payments.logOut?.();
      await deleteServerData();
      await auth.deleteAccount(options);
    } catch (err) {
      analytics.resume();
      // Only a provider without `prepareDeleteAccount` gets here with a re-auth code.
      const password = await handle(err);
      if (password === null) return;
      options = { password };
      continue;
    }
    // e.
    try {
      await wipeLocalData();
    } catch (err) {
      crash.capture(err, { where: "settings.deleteAccount.wipe" });
    }
    toast.show({ title: t("Account deleted") });
    return;
  }
}

export function SettingsScreen() {
  const t = useT();
  const language = useLanguage();
  const choices = consent.useConsent();
  const consentState = useConsentState();
  const [passwordPrompt, askPassword] = usePasswordPrompt();
  const mode = useThemeMode();
  const resolved = useResolvedMode();
  const links = LINKS.filter((l) => isUsableUrl(readynative.urls[l.key]));
  const canRate = storeListingUrl() !== null;
  const version = Constants.expoConfig?.version ?? t("unknown");
  const session = auth.useSession();

  return (
    <Screen scroll>
      <Box gap={6}>
        <Text variant="title">{t("Settings")}</Text>

        <RowGroup
          title={t("Appearance")}
          footer={t("Currently {{mode}}", { mode: t(resolved === "dark" ? "Dark" : "Light") })}
        >
          <Box row gap={2} p={3}>
            {MODES.map((m) => (
              <Box key={m.value} flex={1}>
                <Button
                  size="sm"
                  variant={mode === m.value ? "primary" : "outline"}
                  onPress={() => setThemeMode(m.value)}
                >
                  {t(m.label)}
                </Button>
              </Box>
            ))}
          </Box>
        </RowGroup>

        {languages.length > 1 ? (
          <RowGroup
            title={t("Language")}
            footer={
              languages.some(isRTL)
                ? t("Right-to-left languages flip the layout and restart the app.")
                : undefined
            }
          >
            {languages.map((lang) => (
              <Row
                key={lang}
                title={LANGUAGE_LABELS[lang]}
                chevron={false}
                trailing={
                  language === lang ? (
                    <Icon name="checkmark" fallback="check" size={18} color="brandAccent" />
                  ) : undefined
                }
                onPress={() => void setLanguage(lang)}
              />
            ))}
          </RowGroup>
        ) : null}

        {session.status === "authenticated" ? (
          <RowGroup title={t("Account")} icons>
            <Box gap={1} px={4} py={3}>
              <Text>{session.user.name ?? session.user.email ?? session.user.id}</Text>
              {session.user.name && session.user.email ? (
                <Text variant="caption">{session.user.email}</Text>
              ) : null}
            </Box>
            <Row
              title={t("Sign out")}
              leading={<RowIcon name="rectangle.portrait.and.arrow.right" fallback="logout" />}
              destructive
              chevron={false}
              onPress={signOut}
            />
            <Row
              title={t("Delete account")}
              leading={<RowIcon name="person.crop.circle.badge.xmark" fallback="person_remove" />}
              destructive
              chevron={false}
              onPress={() => void deleteAccount(t, askPassword)}
            />
          </RowGroup>
        ) : null}

        <RowGroup title={t("Privacy")} icons>
          {consentEnabled
            ? privacyCategories.map((category) => (
                <Row
                  key={category}
                  title={t(CATEGORY_ROWS[category].title)}
                  leading={
                    <RowIcon
                      name={CATEGORY_ROWS[category].icon}
                      fallback={CATEGORY_ROWS[category].fallback}
                    />
                  }
                  trailing={
                    <Switch
                      value={choices[category]}
                      onValueChange={(v) => consent.set({ [category]: v })}
                    />
                  }
                />
              ))
            : null}
          {privacyCategories.includes("analytics") ? (
            <Row
              title={t("Do not sell or share my personal information")}
              leading={<RowIcon name="hand.raised" fallback="do_not_touch" />}
              trailing={
                <Switch
                  value={consentState.doNotSell}
                  onValueChange={(v) => consent.setDoNotSell(v)}
                />
              }
            />
          ) : null}
          <Row
            title={t("Export my data")}
            leading={<RowIcon name="square.and.arrow.up" fallback="ios_share" />}
            chevron={false}
            onPress={() => void exportData(t, session.user)}
          />
        </RowGroup>

        {links.length > 0 || canRate ? (
          <RowGroup title={t("Links")} icons>
            {links.map((l) => (
              <Row
                key={l.key}
                title={t(l.label)}
                leading={<RowIcon name={l.icon} fallback={l.fallback} />}
                onPress={() => openUrl(readynative.urls[l.key])}
              />
            ))}
            {canRate ? (
              <Row
                title={t("Rate this app")}
                leading={<RowIcon name="star" fallback="star_rate" />}
                onPress={() => void openStoreListing()}
              />
            ) : null}
          </RowGroup>
        ) : null}

        {onboardingEnabled ? (
          <RowGroup title={t("Onboarding")} icons>
            <Row
              title={t("Reset onboarding")}
              leading={<RowIcon name="arrow.counterclockwise" fallback="restart_alt" />}
              chevron={false}
              onPress={() => {
                resetOnboarding();
                toast.show({ title: t("Onboarding reset") });
              }}
            />
          </RowGroup>
        ) : null}

        {__DEV__ ? (
          <RowGroup title={t("Developer")} icons>
            <Row
              title={t("Trigger review prompt")}
              leading={<RowIcon name="star.bubble" fallback="rate_review" />}
              chevron={false}
              onPress={() => {
                void trackSignificantEvent();
                toast.show({ title: t("Significant event recorded") });
              }}
            />
          </RowGroup>
        ) : null}

        {__DEV__ ? <DeveloperTools /> : null}

        <Text variant="caption" align="center">
          {t("Version {{version}}", { version })}
        </Text>
      </Box>
      {passwordPrompt}
    </Screen>
  );
}
