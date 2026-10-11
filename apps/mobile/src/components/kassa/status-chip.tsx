import { SymbolView, type AndroidSymbol, type SFSymbol } from "expo-symbols";
import { View } from "react-native";

import { Text, useTheme } from "@/components/ui";
import { statusBackground, statusColor, TONE_ICON, type StatusTone } from "@/theme/status";

interface StatusChipProps {
  tone: StatusTone;
  label: string;
  /** Override the tone's default SF Symbol / Material Symbol pair. */
  icon?: { sf: string; md: string };
  testID?: string;
}

/** Status = icon + label + colour, never colour alone (spec §16, WCAG 1.4.1). */
export function StatusChip({ tone, label, icon, testID }: StatusChipProps) {
  const { mode } = useTheme();
  const glyph = icon ?? TONE_ICON[tone];
  const tint = statusColor(tone, mode);
  return (
    <View
      testID={testID}
      accessibilityRole="text"
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        alignSelf: "flex-start",
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: statusBackground(tone, mode),
      }}
    >
      <SymbolView
        name={{
          ios: glyph.sf as SFSymbol,
          android: glyph.md as AndroidSymbol,
          web: glyph.md as AndroidSymbol,
        }}
        size={12}
        tintColor={tint}
        style={{ width: 12, height: 12 }}
      />
      <Text variant="label" weight="semibold" style={{ fontSize: 12 }}>
        {label}
      </Text>
    </View>
  );
}
