import { Switch as RNSwitch, View } from "react-native";

import { isIOS } from "@/lib/utils";
import type { SwitchProps } from "@/components/ui/types";

import { Text } from "./text";
import { useTheme } from "./theme-provider";

export function Switch({ value, onValueChange, disabled = false, label }: SwitchProps) {
  const { colors } = useTheme();
  const control = (
    <RNSwitch
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      trackColor={{ false: colors.muted, true: colors.primary }}
      thumbColor={isIOS ? undefined : value ? colors.primaryForeground : colors.background}
      ios_backgroundColor={colors.muted}
      aria-label={label}
    />
  );

  if (!label) return control;
  return (
    <View
      className="flex-row items-center justify-between gap-3"
      style={disabled ? { opacity: 0.5 } : undefined}
    >
      <Text style={{ flexShrink: 1 }}>{label}</Text>
      {control}
    </View>
  );
}
