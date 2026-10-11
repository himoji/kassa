import type { ReactNode } from "react";
import { RefreshControl, ScrollView } from "react-native";

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
 */
export function ScrollScreen({
  children,
  onRefresh,
  refreshing = false,
  testID,
}: ScrollScreenProps) {
  const { colors } = useTheme();
  return (
    <ScrollView
      testID={testID}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ padding: 16, gap: 24, paddingBottom: 48 }}
      refreshControl={
        onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined
      }
    >
      {children}
    </ScrollView>
  );
}
