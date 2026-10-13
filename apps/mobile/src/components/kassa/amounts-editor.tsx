/**
 * Several amounts edited together, each a row: an emoji badge with its label, the formatted value, and a slider
 * under it. Used by the chat's "amounts" picker (budgets) and the onboarding review sheet (caps, budgets).
 */
import { View } from "react-native";

import { Box, Text, useTheme } from "@/components/ui";
import { snapAmount } from "@/lib/amount-slider";
import { useFormat } from "@/lib/format";

import { AmountSlider } from "./native-controls";

export interface AmountsEditorItem {
  id: string;
  label: string;
  emoji?: string;
  valueMinor: number;
  range: { min: number; max: number; step: number };
}

interface AmountsEditorProps {
  items: readonly AmountsEditorItem[];
  currency: string;
  onChange: (id: string, valueMinor: number) => void;
  disabled?: boolean;
  /** Label of a total row under the items (e.g. "Total per month"); omitted = no total. */
  totalLabel?: string;
}

/** A pill: emoji + label on the muted background. */
export function AmountBadge({ emoji, label }: { emoji?: string; label: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        alignSelf: "flex-start",
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 999,
        backgroundColor: colors.muted,
      }}
    >
      {emoji ? <Text>{emoji}</Text> : null}
      <Text weight="medium">{label}</Text>
    </View>
  );
}

export function AmountsEditor({
  items,
  currency,
  onChange,
  disabled,
  totalLabel,
}: AmountsEditorProps) {
  const f = useFormat();
  const total = items.reduce((sum, i) => sum + i.valueMinor, 0);
  return (
    <Box gap={3}>
      {items.map((item) => (
        <Box key={item.id} gap={1}>
          <Box row align="center" justify="between" gap={3}>
            <AmountBadge emoji={item.emoji} label={item.label} />
            <Text weight="semibold" style={{ fontVariant: ["tabular-nums"] }}>
              {f.money(item.valueMinor, currency)}
            </Text>
          </Box>
          <AmountSlider
            testID={`amount-slider-${item.id}`}
            value={item.valueMinor}
            min={item.range.min}
            max={item.range.max}
            step={item.range.step}
            disabled={disabled}
            onChange={(v) => onChange(item.id, snapAmount(v, item.range))}
          />
        </Box>
      ))}
      {totalLabel ? (
        <Box row justify="between" gap={3}>
          <Text variant="caption">{totalLabel}</Text>
          <Text weight="semibold" style={{ fontVariant: ["tabular-nums"] }}>
            {f.money(total, currency)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
