/**
 * The Settings detail screens one tap from the root list (app/(tabs)/settings/*): each wraps the section that used to
 * sit inline on the single long Settings page.
 */
import { router } from "expo-router";

import { useDemoAvailability, useRecoveryCodesStatus } from "@/api/hooks/auth";
import { useMe } from "@/api/hooks/me";
import { useBudgets } from "@/api/hooks/money";
import { useMandates } from "@/api/hooks/payees";
import { useCaps, usePendingRuleChanges } from "@/api/hooks/settings";
import { DemoProofSection } from "@/components/demo-proof-section";
import { RowGroup } from "@/components/row-group";
import { SettingPicker } from "@/components/kassa/native-controls";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Icon, Row, setThemeMode, useThemeMode, type ThemeMode } from "@/components/ui";
import { env } from "@/lib/env";
import { useFormat } from "@/lib/format";
import {
  LANGUAGES,
  LANGUAGE_LABELS,
  setLanguagePreference,
  useKassaT,
  useLanguagePreference,
  type LanguagePreference,
} from "@/lib/i18n";

import { BackupCodesSection } from "./backup-codes-section";
import { BudgetsSection } from "./budgets-section";
import { CapsSection } from "./caps-section";
import { MandatesSection } from "./mandates-section";
import { PendingChanges } from "./pending-changes";

/** Settings → Limits: the five caps, and loosenings still waiting out their 24 h. */
export function LimitsScreen() {
  const caps = useCaps();
  const pending = usePendingRuleChanges();
  return (
    <ScrollScreen onRefresh={() => Promise.all([caps.refetch(), pending.refetch()])}>
      <CapsSection />
      <PendingChanges />
    </ScrollScreen>
  );
}

/** Settings → Mandates. */
export function MandatesScreen() {
  const mandates = useMandates();
  return (
    <ScrollScreen onRefresh={() => mandates.refetch()}>
      <MandatesSection />
    </ScrollScreen>
  );
}

/** Settings → Budgets. */
export function BudgetsScreen() {
  const budgets = useBudgets();
  return (
    <ScrollScreen onRefresh={() => budgets.refetch()}>
      <BudgetsSection />
    </ScrollScreen>
  );
}

/** Settings → Backup codes. */
export function SecurityScreen() {
  const status = useRecoveryCodesStatus();
  return (
    <ScrollScreen onRefresh={() => status.refetch()}>
      <BackupCodesSection />
    </ScrollScreen>
  );
}

/** Settings → Appearance & language: theme and app language. */
export function AppearanceScreen() {
  const t = useKassaT();
  const themeMode = useThemeMode();
  const language = useLanguagePreference();
  return (
    <ScrollScreen>
      <RowGroup title={t("settings:appearanceTitle")}>
        <SettingPicker<ThemeMode>
          label={t("settings:themeLabel")}
          value={themeMode}
          options={(["system", "light", "dark"] as const).map((m) => ({
            value: m,
            label: t(`settings:theme.${m}`),
          }))}
          onChange={setThemeMode}
        />
        <SettingPicker<LanguagePreference>
          label={t("settings:languageLabel")}
          value={language}
          options={[
            { value: "system", label: t("settings:languageSystem") },
            // Native names, never translated, so a reader can find their own language.
            ...LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_LABELS[l] })),
          ]}
          onChange={(value) => void setLanguagePreference(value)}
          testID="settings-language"
        />
      </RowGroup>
    </ScrollScreen>
  );
}

/** Settings → Demo & proof: the attack evidence, the demo controls and the demo web pages. */
export function DemoProofScreen() {
  const t = useKassaT();
  const f = useFormat();
  const me = useMe();
  const demo = me.data?.demo;
  // The judge build has no admin token: its Demo panel holds the reviewer's own actions (money from home).
  const judgeBuild = useDemoAvailability().data?.judgeMode === true;
  return (
    <ScrollScreen onRefresh={() => me.refetch()}>
      <RowGroup icons>
        <Row
          leading={
            <Icon name="checkmark.shield" fallback="verified_user" size={20} color="foreground" />
          }
          title={t("evidence:title")}
          subtitle={t("evidence:settingsHint")}
          onPress={() => router.push("/evidence")}
        />
        {env.DEMO_ADMIN_TOKEN || __DEV__ || judgeBuild ? (
          <Row
            leading={<Icon name="wand.and.stars" fallback="science" size={20} color="foreground" />}
            title={t("demo:title")}
            subtitle={
              demo
                ? demo.clockMode === "DEMO"
                  ? t("demo:settingsDemoTime", { time: f.dateTime(demo.now) })
                  : t("demo:settingsRealTime")
                : t("demo:settingsHint")
            }
            onPress={() => router.push("/demo")}
          />
        ) : null}
      </RowGroup>
      <DemoProofSection />
    </ScrollScreen>
  );
}
