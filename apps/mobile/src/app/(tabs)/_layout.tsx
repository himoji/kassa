import { NativeTabs } from "expo-router/unstable-native-tabs";
import { Children, type ReactElement, type ReactNode } from "react";
import { I18nManager } from "react-native";

import { useT } from "@/lib/i18n";
import { useTheme } from "@/components/ui";

/**
 * The platform's own tab bar: UITabBar on iOS (Liquid Glass on iOS 26, minimizes while
 * scrolling) and Material 3 navigation on Android. Icons are SF Symbols (`sf`) with a
 * Material Symbols fallback (`md`). Add a tab with `bun run gen screen <name> --tab`.
 */
/**
 * The tabs in reading order. React Native's RTL flips our views but not UIKit's tab bar, so
 * under a right-to-left language the first tab would still sit at the far left.
 */
function inReadingOrder(tabs: ReactElement<{ children?: ReactNode }>): ReactNode[] {
  const items = Children.toArray(tabs.props.children);
  return I18nManager.isRTL ? items.reverse() : items;
}

export default function TabsLayout() {
  const { colors } = useTheme();
  const t = useT();

  return (
    <NativeTabs tintColor={colors.brandAccent} minimizeBehavior="onScrollDown">
      {inReadingOrder(
        <>
          <NativeTabs.Trigger name="index">
            <NativeTabs.Trigger.Icon sf="house.fill" md="home" />
            <NativeTabs.Trigger.Label>{t("Home")}</NativeTabs.Trigger.Label>
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="settings">
            <NativeTabs.Trigger.Icon sf="gearshape.fill" md="settings" />
            <NativeTabs.Trigger.Label>{t("Settings")}</NativeTabs.Trigger.Label>
          </NativeTabs.Trigger>
          {/* gen:tabs */}
        </>
      )}
    </NativeTabs>
  );
}
