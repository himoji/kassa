import type { ComponentProps } from "react";
import type { Stack } from "expo-router";

type StackOptions = NonNullable<ComponentProps<typeof Stack>["screenOptions"]>;

/**
 * Native stack headers per Apple HIG: large titles that collapse into the inline title on scroll
 * (needs the screen's ScrollView first, `contentInsetAdjustmentBehavior="automatic"`), minimal
 * back button. Android renders its own Material top app bar from the same options.
 */
export const largeTitleOptions: StackOptions = {
  headerLargeTitleEnabled: true,
  headerLargeTitleShadowVisible: false,
  headerShadowVisible: false,
  headerTransparent: process.env.EXPO_OS === "ios",
  headerBlurEffect: process.env.EXPO_OS === "ios" ? "systemChromeMaterial" : undefined,
  headerBackButtonDisplayMode: "minimal",
};

export const inlineTitleOptions: StackOptions = {
  ...largeTitleOptions,
  headerLargeTitleEnabled: false,
};
