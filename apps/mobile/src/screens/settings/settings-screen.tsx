import {
  AgentAutonomy,
  MoneyMode,
  NotificationMode,
  PaymentPolicy,
  PRESET_DEFAULTS,
  Region,
  type MeResponse,
  type SettingsOverrides,
} from "@kassa/shared";
import { router } from "expo-router";
import { useState } from "react";

import { useMe } from "@/api/hooks/me";
import { RowGroup } from "@/components/row-group";
import { SettingPicker, SettingSwitch } from "@/components/kassa/native-controls";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Box, Icon, Row, Text, setThemeMode, useThemeMode, type ThemeMode } from "@/components/ui";
import { auth } from "@/lib/auth";
import { confirm } from "@/lib/confirm";
import { env } from "@/lib/env";
import { currencyCodes, useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";
import { KassaIdCard } from "@/screens/wallet/send-screen";

import { BackupCodesSection } from "./backup-codes-section";
import { BudgetsSection } from "./budgets-section";
import { CapsSection } from "./caps-section";
import { MandatesSection } from "./mandates-section";
import { PendingChanges } from "./pending-changes";
import { PresetCards, useDerivedChangesText } from "./preset-cards";
import { useApplySettings } from "./use-settings-update";

/** "Follow preset" is a null override (spec §10: switches derive from the preset unless overridden). */
const FOLLOW = "PRESET";

function overrideOptions<T extends string>(
  values: readonly T[],
  label: (v: T) => string,
  presetLabel: string
) {
  return [
    { value: FOLLOW, label: presetLabel },
    ...values.map((v) => ({ value: v as string, label: label(v) })),
  ];
}

function SettingsBody({ me }: { me: MeResponse }) {
  const t = useKassaT();
  const f = useFormat();
  const { apply, pending } = useApplySettings();
  const derivedText = useDerivedChangesText();
  const s = me.settings;
  const defaults = PRESET_DEFAULTS[s.preset];
  const customised = Object.values(s.overrides).some((v) => v !== null);
  const [advanced, setAdvanced] = useState(customised);
  const themeMode = useThemeMode();

  const setOverride = <K extends keyof SettingsOverrides>(key: K, value: string) =>
    void apply({
      overrides: { [key]: value === FOLLOW ? null : value } as Partial<SettingsOverrides>,
    });

  return (
    <>
      <KassaIdCard />
      <Box gap={3}>
        <Text variant="heading">{t("settings:presetTitle")}</Text>
        <PresetCards
          value={s.preset}
          disabled={pending}
          overrides={s.overrides}
          onChange={(preset) => void apply({ preset }, derivedText(s.preset, preset, s.overrides))}
        />
      </Box>

      <RowGroup title={t("settings:paymentsTitle")} footer={t("settings:paymentsFooter")}>
        <SettingPicker
          label={t("settings:moneyModeLabel")}
          value={s.overrides.moneyMode ?? FOLLOW}
          options={overrideOptions(
            MoneyMode.options,
            (v) => t(`settings:moneyMode.${v}`),
            t("settings:followPreset", { value: t(`settings:moneyMode.${defaults.moneyMode}`) })
          )}
          onChange={(v) => setOverride("moneyMode", v)}
          disabled={pending}
        />
        <SettingPicker
          label={t("settings:regionLabel")}
          value={s.region}
          options={Region.options.map((r) => ({ value: r, label: t(`settings:region.${r}`) }))}
          onChange={(region) => void apply({ region })}
          disabled={pending}
        />
        <SettingPicker
          label={t("settings:homeCurrencyLabel")}
          value={s.homeCurrency}
          options={currencyCodes().map((c) => ({
            value: c,
            label: t("settings:currencyOption", { code: c, name: f.currencyName(c) }),
          }))}
          onChange={(homeCurrency) => void apply({ homeCurrency })}
          disabled={pending}
        />
        <SettingPicker
          label={t("settings:notificationModeLabel")}
          value={s.notificationMode}
          options={NotificationMode.options.map((m) => ({
            value: m,
            label: t(`settings:notificationMode.${m}`),
          }))}
          onChange={(notificationMode) => void apply({ notificationMode })}
          disabled={pending}
        />
      </RowGroup>

      <RowGroup title={t("settings:advancedTitle")} footer={t("settings:advancedFooter")}>
        <SettingSwitch
          label={t("settings:customise")}
          description={t("settings:customiseHint")}
          value={advanced}
          onChange={(on) => {
            setAdvanced(on);
            if (!on && customised) {
              void apply({
                overrides: { agentAutonomy: null, paymentPolicy: null, moneyMode: null },
              });
            }
          }}
        />
        {advanced ? (
          <SettingPicker
            label={t("settings:agentAutonomyLabel")}
            value={s.overrides.agentAutonomy ?? FOLLOW}
            options={overrideOptions(
              AgentAutonomy.options,
              (v) => t(`settings:agentAutonomy.${v}`),
              t("settings:followPreset", {
                value: t(`settings:agentAutonomy.${defaults.agentAutonomy}`),
              })
            )}
            onChange={(v) => setOverride("agentAutonomy", v)}
            disabled={pending}
          />
        ) : null}
        {advanced ? (
          <SettingPicker
            label={t("settings:paymentPolicyLabel")}
            value={s.overrides.paymentPolicy ?? FOLLOW}
            options={overrideOptions(
              PaymentPolicy.options,
              (v) => t(`settings:paymentPolicy.${v}`),
              t("settings:followPreset", {
                value: t(`settings:paymentPolicy.${defaults.paymentPolicy}`),
              })
            )}
            onChange={(v) => setOverride("paymentPolicy", v)}
            disabled={pending}
          />
        ) : null}
        <Box p={4}>
          <Text variant="caption">
            {t("settings:effectiveNow", {
              agent: t(`settings:agentAutonomy.${me.effective.agentAutonomy}`),
              payments: t(`settings:paymentPolicy.${me.effective.paymentPolicy}`),
              mode: t(`settings:moneyMode.${me.effective.moneyMode}`),
            })}
          </Text>
        </Box>
      </RowGroup>

      <PendingChanges />
      <BudgetsSection />
      <CapsSection />
      <MandatesSection />
      <BackupCodesSection />

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
      </RowGroup>

      <RowGroup title={t("settings:moreTitle")} icons>
        <Row
          leading={<Icon name="person.2" fallback="group" size={20} color="foreground" />}
          title={t("payees:title")}
          onPress={() => router.push("/payees")}
        />
        <Row
          leading={<Icon name="calendar" fallback="event" size={20} color="foreground" />}
          title={t("bills:title")}
          onPress={() => router.push("/bills")}
        />
        <Row
          leading={<Icon name="creditcard" fallback="credit_card" size={20} color="foreground" />}
          title={t("wallet:linked.title")}
          subtitle={t("wallet:linked.rowHint")}
          onPress={() => router.push("/linked-accounts")}
          testID="settings-linked-accounts"
        />
        <Row
          leading={
            <Icon
              name="arrow.up.arrow.down"
              fallback="import_export"
              size={20}
              color="foreground"
            />
          }
          title={t("settings:data.title")}
          subtitle={t("settings:data.rowHint")}
          onPress={() => router.push("/data")}
        />
        <Row
          leading={<Icon name="wave.3.right" fallback="contactless" size={20} color="foreground" />}
          title={t("shortcut:title")}
          subtitle={t("shortcut:settingsHint")}
          onPress={() => router.push("/shortcut")}
        />
        <Row
          leading={
            <Icon
              name="iphone.and.arrow.forward"
              fallback="phonelink"
              size={20}
              color="foreground"
            />
          }
          title={t("lite:pairDevice.rowTitle")}
          subtitle={t("lite:pairDevice.rowHint")}
          onPress={() => router.push("/pair-lite")}
        />
        <Row
          leading={
            <Icon
              name="doc.text.magnifyingglass"
              fallback="description"
              size={20}
              color="foreground"
            />
          }
          title={t("credit:title")}
          onPress={() => router.push("/credit-record")}
        />
        {env.DEMO_ADMIN_TOKEN || __DEV__ ? (
          <Row
            leading={<Icon name="wand.and.stars" fallback="science" size={20} color="foreground" />}
            title={t("demo:title")}
            subtitle={t("demo:settingsHint")}
            onPress={() => router.push("/demo")}
          />
        ) : null}
        <Row
          leading={
            <Icon
              name="rectangle.portrait.and.arrow.right"
              fallback="logout"
              size={20}
              color="destructive"
            />
          }
          title={t("settings:signOut")}
          destructive
          onPress={async () => {
            const ok = await confirm({
              title: t("settings:signOutTitle"),
              confirmLabel: t("settings:signOut"),
              cancelLabel: t("common:cancel"),
            });
            if (ok) await auth.signOut();
          }}
        />
      </RowGroup>
    </>
  );
}

export function SettingsScreen() {
  const me = useMe();
  return (
    <ScrollScreen onRefresh={() => void me.refetch()} refreshing={me.isRefetching}>
      <QueryView query={me} skeletonRows={6}>
        {(data) => <SettingsBody me={data} />}
      </QueryView>
    </ScrollScreen>
  );
}
