/**
 * Semantic status colours. iOS uses UIKit system colours through expo-router's `Color` (they adapt
 * to dark mode and Increase Contrast); Android and web use the same Apple system values per mode.
 * Status is never colour alone (spec §16): every use pairs it with a label and an icon.
 */
import { Color } from "expo-router";
import { Platform, type ColorValue } from "react-native";

import type { ResolvedMode } from "@/theme/tokens";

export type StatusTone = "positive" | "warning" | "critical" | "info" | "neutral";

const HEX: Record<ResolvedMode, Record<StatusTone, string>> = {
  light: {
    positive: "#248A3D",
    warning: "#C93400",
    critical: "#D70015",
    info: "#0040DD",
    neutral: "#6C6C70",
  },
  dark: {
    positive: "#30D158",
    warning: "#FF9F0A",
    critical: "#FF6961",
    info: "#409CFF",
    neutral: "#AEAEB2",
  },
};

export function statusColor(tone: StatusTone, mode: ResolvedMode): ColorValue {
  if (Platform.OS === "ios") {
    switch (tone) {
      case "positive":
        return Color.ios.systemGreen;
      case "warning":
        return Color.ios.systemOrange;
      case "critical":
        return Color.ios.systemRed;
      case "info":
        return Color.ios.systemBlue;
      case "neutral":
        return Color.ios.secondaryLabel;
    }
  }
  return HEX[mode][tone];
}

/** A soft background for chips; hex with alpha (ISO/IEC 61966 sRGB), so not PlatformColor. */
export function statusBackground(tone: StatusTone, mode: ResolvedMode): string {
  return `${HEX[mode][tone]}22`;
}

export const TONE_ICON: Record<StatusTone, { sf: string; md: string }> = {
  positive: { sf: "checkmark.seal.fill", md: "verified" },
  warning: { sf: "clock.fill", md: "schedule" },
  critical: { sf: "xmark.octagon.fill", md: "block" },
  info: { sf: "info.circle.fill", md: "info" },
  neutral: { sf: "circle.fill", md: "circle" },
};
