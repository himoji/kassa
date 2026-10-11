/**
 * Haptic feedback (Apple HIG "Playing haptics"; Android HapticFeedbackConstants via expo-haptics).
 * Success / warning / error notifications for outcomes, a light impact for selections. No-ops on
 * web and never throws: a missing haptic engine must not break a payment flow.
 */
import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

function run(fn: () => Promise<void>): void {
  if (Platform.OS === "web") return;
  fn().catch(() => {});
}

export const haptics = {
  success: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  error: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
  selection: () => run(() => Haptics.selectionAsync()),
  impact: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
};
