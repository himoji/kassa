import { useEffect } from "react";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { useTheme } from "./theme-provider";

const SIZE = { sm: 18, lg: 32 } as const;

export interface SpinnerProps {
  size?: keyof typeof SIZE;
  /** Defaults to the theme's primary colour. */
  color?: string;
}

/**
 * A ring with one open quarter, turning clockwise about its own centre. Replaces ActivityIndicator, whose
 * web build rotates an SVG inside a box that is not square under the global CSS, so it wobbled off-centre.
 * The rotated view here is a fixed square, so its transform origin is always the middle.
 */
export function Spinner({ size = "sm", color }: SpinnerProps) {
  const { colors } = useTheme();
  const turn = useSharedValue(0);

  useEffect(() => {
    turn.set(withRepeat(withTiming(360, { duration: 800, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(turn);
  }, [turn]);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get()}deg` }] }));
  const px = SIZE[size];
  const tint = color ?? colors.primary;

  return (
    <Animated.View
      accessibilityRole="progressbar"
      aria-busy
      style={[
        {
          width: px,
          height: px,
          borderRadius: px / 2,
          borderWidth: Math.max(2, Math.round(px / 9)),
          borderColor: tint,
          borderTopColor: "transparent",
          transformOrigin: "50% 50%",
        },
        animatedStyle,
      ]}
    />
  );
}
