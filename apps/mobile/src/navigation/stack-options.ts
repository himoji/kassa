import type { ComponentProps } from "react";
import type { Stack } from "expo-router";
import { Platform } from "react-native";

import { WebHeader } from "./web-header";

type StackOptions = NonNullable<ComponentProps<typeof Stack>["screenOptions"]>;

/**
 * iOS 26 draws its own scroll edge effect (Liquid Glass) under a transparent bar. A `headerBlurEffect` there adds
 * a blur view on top of the bar that covers the large title, so the title reads as text behind frosted glass; only
 * older iOS gets the explicit blur.
 */
export function iosHeaderBlur(
  os: string | undefined = process.env.EXPO_OS,
  version: string | number = Platform.Version
): "systemChromeMaterial" | undefined {
  if (os !== "ios") return undefined;
  return Number.parseInt(String(version), 10) >= 26 ? undefined : "systemChromeMaterial";
}

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
  headerBlurEffect: iosHeaderBlur(),
  headerBackButtonDisplayMode: "minimal",
  // Web: the header lines up with the centred content column (ScrollScreen) instead of the window edges.
  ...(process.env.EXPO_OS === "web"
    ? { header: WebHeader, contentStyle: { width: "100%", maxWidth: 792, alignSelf: "center" } }
    : null),
};

export const inlineTitleOptions: StackOptions = {
  ...largeTitleOptions,
  headerLargeTitleEnabled: false,
};
