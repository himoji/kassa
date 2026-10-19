import { useCallback, useState, type ReactNode } from "react";
import { Platform, RefreshControl } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

import { useTheme } from "@/components/ui";

interface ScrollScreenProps {
  children?: ReactNode;
  /** Pull to refresh. The spinner shows only for a user pull, until the returned promise settles. */
  onRefresh?: () => unknown;
  testID?: string;
}

/**
 * Pull-to-refresh state driven only by the user's pull, so background refetches (polls, refetch
 * on mount) never show the iOS spinner and push content under the transparent header.
 */
export function usePullRefresh(onRefresh?: () => unknown) {
  const [refreshing, setRefreshing] = useState(false);
  const handle = useCallback(() => {
    if (!onRefresh) return;
    setRefreshing(true);
    void Promise.resolve(onRefresh()).finally(() => setRefreshing(false));
  }, [onRefresh]);
  return { refreshing, onRefresh: handle };
}

/**
 * The scroll container every stack screen starts with: first child of the route, with
 * `contentInsetAdjustmentBehavior="automatic"` so native large titles collapse and the safe area
 * and tab bar insets are handled by UIKit (Apple HIG "Navigation bars").
 *
 * Keyboard-aware: a focused field scrolls above the keyboard, dragging the list dismisses it
 * (interactive on iOS), and taps on buttons go through while it is up.
 */
export function ScrollScreen({ children, onRefresh, testID }: ScrollScreenProps) {
  const { colors } = useTheme();
  const pull = usePullRefresh(onRefresh);
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
        Platform.OS === "web" && {
          width: "100%",
          maxWidth: 760,
          alignSelf: "center",
          paddingTop: 24,
        },
      ]}
      refreshControl={
        onRefresh ? (
          <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
        ) : undefined
      }
    >
      {children}
    </KeyboardAwareScrollView>
  );
}
