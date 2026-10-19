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
import { useState } from "react";

import { useMe } from "@/api/hooks/me";
import { RowGroup } from "@/components/row-group";
import { SettingPicker, SettingSwitch } from "@/components/kassa/native-controls";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Box, Text } from "@/components/ui";
import { currencyCodes, useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

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

function PresetBody({ me }: { me: MeResponse }) {
  const t = useKassaT();
  const f = useFormat();
  const { apply, pending } = useApplySettings();
  const derivedText = useDerivedChangesText();
  const s = me.settings;
  const defaults = PRESET_DEFAULTS[s.preset];
  const customised = Object.values(s.overrides).some((v) => v !== null);
  const [advanced, setAdvanced] = useState(customised);

  const setOverride = <K extends keyof SettingsOverrides>(key: K, value: string) =>
    void apply({
      overrides: { [key]: value === FOLLOW ? null : value } as Partial<SettingsOverrides>,
    });

  return (
    <>
      <PresetCards
        value={s.preset}
        disabled={pending}
        overrides={s.overrides}
        onChange={(preset) => void apply({ preset }, derivedText(s.preset, preset, s.overrides))}
      />

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
    </>
  );
}

/** Settings → Preset: the three preset cards, the payment settings they derive, and per-setting overrides. */
export function PresetScreen() {
  const me = useMe();
  return (
    <ScrollScreen onRefresh={() => me.refetch()}>
      <QueryView query={me} skeletonRows={6}>
        {(data) => <PresetBody me={data} />}
      </QueryView>
    </ScrollScreen>
  );
}
