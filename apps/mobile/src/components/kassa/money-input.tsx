import { currencyExponent, fromMinor, toMinor } from "@kassa/shared";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { Text, useTheme } from "@/components/ui";

/** "1 400", "1,400", "1400.50", "1400,50" → minor units; null when it is not an amount. */
export function parseMoneyInput(text: string, currency: string): number | null {
  const cleaned = text
    .replace(/[\s\u00a0']/g, "")
    .replace(/,(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  try {
    return toMinor(
      `${whole}${frac ? `.${frac.slice(0, currencyExponent(currency))}` : ""}`,
      currency
    );
  } catch {
    return null;
  }
}

/** Minor units as typed text ("1400", "1400.5"): no grouping, so it parses back unchanged. */
function asText(minor: number | null, currency: string): string {
  if (minor === null) return "";
  return fromMinor(minor, currency)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*?)0+$/, "$1");
}

/**
 * An amount typed in major units (the currency code beside it). Reports minor units, or null while the text is
 * empty or not an amount; an outside change of `valueMinor` (a slider, an applied suggestion) replaces the text.
 */
export function MoneyInput({
  valueMinor,
  currency,
  onChange,
  accessibilityLabel,
  placeholder,
  testID,
}: {
  valueMinor: number | null;
  currency: string;
  onChange: (minor: number | null) => void;
  accessibilityLabel: string;
  placeholder?: string;
  testID?: string;
}) {
  const { colors } = useTheme();
  const [text, setText] = useState(() => asText(valueMinor, currency));
  // Only an outside change of the value (not the user's own keystrokes) replaces the text.
  const key = `${valueMinor}|${currency}`;
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    if (parseMoneyInput(text, currency) !== valueMinor) setText(asText(valueMinor, currency));
  }
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: 44,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <TextInput
        testID={testID}
        value={text}
        onChangeText={(next) => {
          setText(next);
          onChange(parseMoneyInput(next, currency));
        }}
        keyboardType="decimal-pad"
        inputMode="decimal"
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        accessibilityLabel={accessibilityLabel}
        style={{
          flex: 1,
          minHeight: 40,
          color: colors.foreground,
          fontSize: 17,
          fontVariant: ["tabular-nums"],
        }}
      />
      <Text variant="caption">{currency}</Text>
    </View>
  );
}
