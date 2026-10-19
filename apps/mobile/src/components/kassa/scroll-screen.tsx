import type { ReactNode } from "react";
import { Platform, RefreshControl } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

import { useTheme } from "@/components/ui";

interface ScrollScreenProps {
  children?: ReactNode;
  /** Pull to refresh (spinner shows while `refreshing`). */
  onRefresh?: () => void;
  refreshing?: boolean;
  testID?: string;
}

/**
 * The scroll container every stack screen starts with: first child of the route, with
 * `contentInsetAdjustmentBehavior="automatic"` so native large titles collapse and the safe area
 * and tab bar insets are handled by UIKit (Apple HIG "Navigation bars").
 *
 * Keyboard-aware: a focused field scrolls above the keyboard, dragging the list dismisses it
 * (interactive on iOS), and taps on buttons go through while it is up.
 */
export function ScrollScreen({
  children,
  onRefresh,
  refreshing = false,
  testID,
}: ScrollScreenProps) {
  const { colors } = useTheme();
  return (
    <KeyboardAwareScrollView
      testID={testID}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      bottomOffset={24}
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={[
        { padding: 16, gap: 24, paddingBottom: 48 },
        // Web on a wide window: one readable column instead of a stretched phone layout.
        Platform.OS === "web" && { width: "100%", maxWidth: 760, alignSelf: "center", paddingTop: 24 },
      ]}
      refreshControl={
        onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined
      }
    >
      {children}
    </KeyboardAwareScrollView>
  );
}
