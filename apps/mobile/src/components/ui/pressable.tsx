import * as Haptics from "expo-haptics";
import { createAnimatedPressable } from "pressto";

import { isWeb } from "@/lib/utils";
import type { PressableProps } from "@/components/ui/types";

/**
 * Pressto (https://github.com/enzomanuelmangano/pressto): the press runs on the UI thread
 * through a gesture-handler button, so the scale tracks the finger at 120 Hz even while JS is
 * busy, and a press inside a scrolling list cancels cleanly when the list scrolls. `scale` is
 * how far it shrinks at full press.
 */
const ScalePressable = createAnimatedPressable<{ scale: number }>((progress, { metadata }) => {
  "worklet";
  return { transform: [{ scale: 1 - (1 - metadata.scale) * progress }] };
});

/** Press feedback shared by every tappable primitive: native-thread scale + light haptic. */
export function Pressable({
  onPress,
  haptic = true,
  scale = 0.97,
  disabled = false,
  style,
  children,
}: PressableProps) {
  const handlePress = () => {
    if (haptic && !isWeb) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {
        /* haptics unavailable (simulator, permissions) - never block the press */
      });
    }
    onPress();
  };

  return (
    <ScalePressable
      disabled={disabled}
      metadata={{ scale }}
      onPress={handlePress}
      style={[disabled ? { opacity: 0.5 } : null, style]}
    >
      {children}
    </ScalePressable>
  );
}
