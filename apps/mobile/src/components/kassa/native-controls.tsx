/**
 * Settings controls on @expo/ui universal components: SwiftUI on iOS, Jetpack Compose on Android,
 * react-native-web implementations on web (the universal layer supports all three, Expo SDK 57
 * docs "Universal"). Each sits in its own `Host`, as required inside React Native views.
 */
import { Host, Picker, Slider, Switch } from "@expo/ui";
import { View } from "react-native";

import { Text, useTheme } from "@/components/ui";

export interface PickerOption<T extends string> {
  value: T;
  label: string;
}

interface SettingPickerProps<T extends string> {
  label: string;
  value: T;
  options: readonly PickerOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  testID?: string;
}

/** Labelled menu picker row (Apple HIG "Pop-up buttons"; Material 3 exposed dropdown). */
export function SettingPicker<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  testID,
}: SettingPickerProps<T>) {
  const { mode } = useTheme();
  return (
    <View
      testID={testID}
      style={{
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 16,
        gap: 12,
      }}
    >
      <Text style={{ flex: 1 }}>{label}</Text>
      <Host matchContents colorScheme={mode}>
        <Picker
          selectedValue={value}
          enabled={!disabled}
          onValueChange={(v) => onChange(v as T)}
          testID={testID ? `${testID}-picker` : undefined}
        >
          {options.map((o) => (
            <Picker.Item key={o.value} label={o.label} value={o.value} />
          ))}
        </Picker>
      </Host>
    </View>
  );
}

interface SettingSwitchProps {
  label: string;
  description?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}

export function SettingSwitch({
  label,
  description,
  value,
  onChange,
  disabled,
}: SettingSwitchProps) {
  const { mode } = useTheme();
  return (
    <View
      style={{
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 16,
        paddingVertical: 8,
        gap: 12,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text>{label}</Text>
        {description ? <Text variant="caption">{description}</Text> : null}
      </View>
      <Host matchContents colorScheme={mode}>
        <Switch value={value} onValueChange={onChange} disabled={disabled} label={undefined} />
      </Host>
    </View>
  );
}

interface SettingSliderProps {
  label: string;
  valueLabel: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  /** Called when the user lets go, to commit (avoids one PATCH per tick). */
  onCommit?: (value: number) => void;
}

export function SettingSlider({
  label,
  valueLabel,
  value,
  min,
  max,
  step,
  onChange,
}: SettingSliderProps) {
  const { mode } = useTheme();
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 6 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
        <Text>{label}</Text>
        <Text weight="semibold" style={{ fontVariant: ["tabular-nums"] }}>
          {valueLabel}
        </Text>
      </View>
      <Host matchContents={{ vertical: true }} style={{ width: "100%" }} colorScheme={mode}>
        <Slider value={value} min={min} max={max} step={step} onValueChange={onChange} />
      </Host>
    </View>
  );
}

interface AmountSliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  testID?: string;
}

/** A bare full-width slider (no row chrome), for amounts inside cards and sheets. */
export function AmountSlider({
  value,
  min,
  max,
  step,
  onChange,
  disabled,
  testID,
}: AmountSliderProps) {
  const { mode } = useTheme();
  return (
    <Host matchContents={{ vertical: true }} style={{ width: "100%" }} colorScheme={mode}>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        onValueChange={onChange}
        disabled={disabled}
        testID={testID}
      />
    </Host>
  );
}
