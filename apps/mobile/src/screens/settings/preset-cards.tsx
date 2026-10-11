import {
  Preset,
  PRESET_DEFAULTS,
  presetDerivedChanges,
  type SettingsOverrides,
} from "@kassa/shared";
import { Pressable, View } from "react-native";

import { StatusChip } from "@/components/kassa/status-chip";
import { Box, Icon, Text, useTheme } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";

const ICONS: Record<Preset, { sf: string; md: string }> = {
  ASK_ME: { sf: "hand.raised.fill", md: "back_hand" },
  SMART: { sf: "sparkles", md: "auto_awesome" },
  AUTOPILOT: { sf: "airplane", md: "flight" },
};

/** "Money: Capped wallet → Pay in place" lines for the settings a preset switch changes implicitly (p2 B6). */
export function useDerivedChangesText() {
  const t = useKassaT();
  return (from: Preset, to: Preset, overrides: SettingsOverrides): string =>
    presetDerivedChanges(from, to, overrides)
      .map((c) =>
        t("settings:derivedChange", {
          setting: t(`settings:derivedSetting.${c.setting}`),
          from: t(`settings:${c.setting}.${c.from}`),
          to: t(`settings:${c.setting}.${c.to}`),
        })
      )
      .join("; ");
}

/** The three preset cards (spec §10, §16); a radio group for assistive tech (WAI-ARIA radio). */
export function PresetCards({
  value,
  onChange,
  disabled,
  overrides,
}: {
  value: Preset;
  onChange: (preset: Preset) => void;
  disabled?: boolean;
  /** The user's overrides: a card shows which of the user's effective settings choosing it would change. */
  overrides?: SettingsOverrides;
}) {
  const t = useKassaT();
  const derivedText = useDerivedChangesText();
  const { colors } = useTheme();
  return (
    <View accessibilityRole="radiogroup" style={{ gap: 12 }}>
      {Preset.options.map((preset) => {
        const selected = preset === value;
        const d = PRESET_DEFAULTS[preset];
        const changes = !selected && overrides ? derivedText(value, preset, overrides) : "";
        return (
          <Pressable
            key={preset}
            disabled={disabled}
            onPress={() => !selected && onChange(preset)}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, disabled }}
            accessibilityLabel={`${t(`settings:preset.${preset}.title`)}. ${t(`settings:preset.${preset}.body`)}`}
            style={{
              borderRadius: 16,
              borderCurve: "continuous",
              borderWidth: selected ? 2 : 1,
              borderColor: selected ? colors.brandAccent : colors.border,
              backgroundColor: colors.card,
              padding: 16,
              gap: 8,
              minHeight: 44,
              opacity: disabled ? 0.6 : 1,
            }}
          >
            <Box row gap={3} align="center">
              <Icon
                name={ICONS[preset].sf}
                fallback={ICONS[preset].md}
                size={22}
                color={selected ? "brandAccent" : "foreground"}
              />
              <Text weight="semibold" style={{ flex: 1 }}>
                {t(`settings:preset.${preset}.title`)}
              </Text>
              {selected ? <StatusChip tone="info" label={t("settings:selected")} /> : null}
            </Box>
            <Text variant="caption">{t(`settings:preset.${preset}.body`)}</Text>
            <Text variant="caption">
              {t("settings:presetDefaults", {
                agent: t(`settings:agentAutonomy.${d.agentAutonomy}`),
                payments: t(`settings:paymentPolicy.${d.paymentPolicy}`),
                mode: t(`settings:moneyMode.${d.moneyMode}`),
              })}
            </Text>
            {changes ? (
              <Text variant="caption" weight="semibold" testID={`preset-${preset}-changes`}>
                {t("settings:presetAlsoChanges", { changes })}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
