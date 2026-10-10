import { BottomSheet } from "@expo/ui";

import type { SheetProps } from "@/components/ui/types";

import { useTheme } from "./theme-provider";

/**
 * Native bottom sheet (`BottomSheet` from `@expo/ui`): SwiftUI on iOS, Jetpack Compose on
 * Android, a drawer on web. It works in Expo Go. The sheet paints the theme background;
 * children are regular React Native views.
 */
export function Sheet({ visible, onClose, detents, grabber = true, children }: SheetProps) {
  const { colors } = useTheme();
  return (
    <BottomSheet
      isPresented={visible}
      onDismiss={onClose}
      snapPoints={detents}
      showDragIndicator={grabber}
      containerColor={colors.background}
    >
      {children}
    </BottomSheet>
  );
}
