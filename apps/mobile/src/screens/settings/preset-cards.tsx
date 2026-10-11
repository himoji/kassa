import { Preset, PRESET_DEFAULTS } from "@kassa/shared";
import { Pressable, View } from "react-native";

import { StatusChip } from "@/components/kassa/status-chip";
import { Box, Icon, Text, useTheme } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";

const ICONS: Record<Preset, { sf: string; md: string }> = {
  ASK_ME: { sf: "hand.raised.fill", md: "back_hand" },
  SMART: { sf: "sparkles", md: "auto_awesome" },
  AUTOPILOT: { sf: "airplane", md: "flight" },
};

/** The three preset cards (spec §10, §16); a radio group for assistive tech (WAI-ARIA radio). */
export function PresetCards({
  value,
  onChange,
  disabled,
}: {
  value: Preset;
  onChange: (preset: Preset) => void;
  disabled?: boolean;
}) {
  const t = useKassaT();
  const { colors } = useTheme();
  return (
    <View accessibilityRole="radiogroup" style={{ gap: 12 }}>
      {Preset.options.map((preset) => {
        const selected = preset === value;
        const d = PRESET_DEFAULTS[preset];
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
          </Pressable>
        );
      })}
    </View>
  );
}
