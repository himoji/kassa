import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Pressable as RNPressable, View } from "react-native";

import { isWeb } from "@/lib/utils";
import { space } from "@/theme/tokens";
import type { RowProps } from "@/components/ui/types";

import { Icon } from "./icon";
import { Text } from "./text";
import { useTheme } from "./theme-provider";

/** Apple's minimum tap target; the leading slot is sized to match `Icon`'s box. */
const MIN_HEIGHT = 44;
const LEADING_SIZE = 28;

/**
 * One line of a settings-style list. Draws no divider - `List` (or a `Divider`
 * between Rows in a `Card`) owns the separators.
 */
export function Row({
  title,
  subtitle,
  leading,
  trailing,
  chevron,
  onPress,
  onLongPress,
  destructive = false,
  disabled = false,
  testID,
  style,
}: RowProps) {
  const { colors } = useTheme();
  const [pressed, setPressed] = useState(false);
  const pressable = onPress !== undefined || onLongPress !== undefined;
  const showChevron = chevron ?? (onPress !== undefined && trailing === undefined);

  const handlePress = () => {
    if (!isWeb) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {
        /* haptics unavailable (simulator, permissions) - never block the press */
      });
    }
    onPress?.();
  };

  const body = (
    <>
      {leading !== undefined && leading !== null ? (
        <View
          className="items-center justify-center"
          style={{ width: LEADING_SIZE, height: LEADING_SIZE }}
        >
          {typeof leading === "string" ? (
            <Icon name={leading} size={22} color={destructive ? "destructive" : "foreground"} />
          ) : (
            leading
          )}
        </View>
      ) : null}

      <View className="flex-1 justify-center" style={{ gap: 2 }}>
        <Text numberOfLines={1} color={destructive ? "destructive" : undefined}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      {trailing}
      {showChevron ? (
        <Icon name="chevron.forward" fallback="chevron_right" size={18} color="mutedForeground" />
      ) : null}
    </>
  );

  // A plain style array, not `className` or a `style` function: NativeWind's Pressable interop
  // drops a function `style`, which left rows without padding or a row direction.
  const layout = {
    flexDirection: "row",
    alignItems: "center",
    gap: space[3],
    minHeight: MIN_HEIGHT,
    paddingHorizontal: space[4],
    paddingVertical: space[2],
  } as const;

  if (!pressable) {
    return (
      <View testID={testID} style={[layout, style]}>
        {body}
      </View>
    );
  }

  return (
    <RNPressable
      testID={testID}
      role="button"
      disabled={disabled}
      onPress={handlePress}
      onLongPress={onLongPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[
        layout,
        pressed ? { backgroundColor: colors.accent } : null,
        disabled ? { opacity: 0.5 } : null,
        style,
      ]}
    >
      {body}
    </RNPressable>
  );
}
