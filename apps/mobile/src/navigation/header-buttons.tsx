import { Stack } from "expo-router";
import type { SFSymbol } from "sf-symbols-typescript";
import { Pressable } from "react-native";

import { Box, Icon } from "@/components/ui";
import { isIOS } from "@/lib/utils";

export interface HeaderButton {
  /** SF Symbol (iOS). */
  icon: string;
  /** Material Symbol (Android, web). */
  fallback: string;
  label: string;
  onPress: () => void;
  testID?: string;
}

/**
 * Buttons in a stack screen's navigation bar. On iOS they are real bar button items (`Stack.Toolbar`): UIKit lays
 * them out, tints them and groups them in the system glass, like every other iOS app. Elsewhere they are icon buttons
 * in `headerLeft` / `headerRight`. Render it inside the screen component; `buttons` keeps its order, leading first.
 */
export function HeaderButtons({
  placement,
  buttons,
}: {
  placement: "left" | "right";
  buttons: readonly HeaderButton[];
}) {
  if (isIOS) {
    return (
      <Stack.Toolbar placement={placement}>
        {buttons.map((b) => (
          <Stack.Toolbar.Button
            key={b.icon}
            icon={b.icon as SFSymbol}
            accessibilityLabel={b.label}
            onPress={b.onPress}
          />
        ))}
      </Stack.Toolbar>
    );
  }
  const render = () => (
    <Box row gap={1} align="center">
      {buttons.map((b) => (
        <Pressable
          key={b.icon}
          onPress={b.onPress}
          accessibilityRole="button"
          accessibilityLabel={b.label}
          testID={b.testID}
          hitSlop={4}
          style={{ minWidth: 40, minHeight: 40, alignItems: "center", justifyContent: "center" }}
        >
          <Icon name={b.icon} fallback={b.fallback} size={22} />
        </Pressable>
      ))}
    </Box>
  );
  return (
    <Stack.Screen
      options={placement === "left" ? { headerLeft: render } : { headerRight: render }}
    />
  );
}
