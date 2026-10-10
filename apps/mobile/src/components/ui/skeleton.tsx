import { useEffect } from "react";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { radius as radii } from "@/theme/tokens";
import type { SkeletonProps } from "@/components/ui/types";

import { useTheme } from "./theme-provider";

export function Skeleton({ w = "100%", h = 16, radius = "md", style }: SkeletonProps) {
  const { colors } = useTheme();
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.set(withRepeat(withTiming(0.4, { duration: 800 }), -1, true));
    return () => cancelAnimation(opacity);
  }, [opacity]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.get() }));

  return (
    <Animated.View
      aria-busy
      style={[
        { width: w, height: h, borderRadius: radii[radius], backgroundColor: colors.muted },
        animatedStyle,
        style,
      ]}
    />
  );
}
