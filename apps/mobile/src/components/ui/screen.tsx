import { View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";

import { space } from "@/theme/tokens";
import type { SafeArea, ScreenProps } from "@/components/ui/types";

import { useTheme } from "./theme-provider";

const EDGES: Record<SafeArea, Edge[]> = {
  top: ["top"],
  bottom: ["bottom"],
  both: ["top", "bottom"],
  none: [],
};

export function Screen({
  scroll = false,
  padded = true,
  safe = "both",
  bg = "background",
  children,
}: ScreenProps) {
  const { colors } = useTheme();
  const padding = padded ? space[4] : 0;

  return (
    <SafeAreaView edges={EDGES[safe]} style={{ flex: 1, backgroundColor: colors[bg] }}>
      {scroll ? (
        <KeyboardAwareScrollView
          contentContainerStyle={{ padding, flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          bottomOffset={space[4]}
        >
          {children}
        </KeyboardAwareScrollView>
      ) : (
        <View style={{ flex: 1, padding }}>{children}</View>
      )}
    </SafeAreaView>
  );
}
