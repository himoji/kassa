import { TabList, TabSlot, TabTrigger, Tabs } from "expo-router/ui";
import { Pressable } from "react-native";

import { Icon, Text, useTheme } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";

/**
 * Web has no system tab bar (Expo Router docs, "Custom web layout"): headless tabs from
 * expo-router/ui with a bottom bar that mirrors the native one (WAI-ARIA tablist semantics).
 */
const TABS = [
  { name: "home", href: "/home", sf: "house.fill", md: "home" },
  { name: "chat", href: "/chat", sf: "bubble.left.and.text.bubble.right.fill", md: "forum" },
  { name: "activity", href: "/activity", sf: "list.bullet.rectangle", md: "receipt_long" },
  { name: "cards", href: "/cards", sf: "creditcard.fill", md: "credit_card" },
  { name: "settings", href: "/settings", sf: "gearshape.fill", md: "settings" },
] as const;

function TabButton({
  label,
  sf,
  md,
  isFocused,
  ...rest
}: {
  label: string;
  sf: string;
  md: string;
  isFocused?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      {...rest}
      accessibilityRole="tab"
      accessibilityState={{ selected: Boolean(isFocused) }}
      style={{ flex: 1, minHeight: 52, alignItems: "center", justifyContent: "center", gap: 2 }}
    >
      <Icon
        name={sf}
        fallback={md}
        size={22}
        color={isFocused ? "brandAccent" : "mutedForeground"}
      />
      <Text
        variant="label"
        color={isFocused ? "brandAccent" : "mutedForeground"}
        style={{ fontSize: 11 }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export default function WebTabsLayout() {
  const t = useKassaT();
  const { colors } = useTheme();
  return (
    <Tabs>
      <TabSlot />
      <TabList
        style={{
          flexDirection: "row",
          borderTopWidth: 1,
          borderTopColor: colors.border,
          backgroundColor: colors.background,
        }}
      >
        {TABS.map((tab) => (
          <TabTrigger key={tab.name} name={tab.name} href={tab.href} asChild>
            <TabButton label={t(`${tab.name}:tab`)} sf={tab.sf} md={tab.md} />
          </TabTrigger>
        ))}
      </TabList>
    </Tabs>
  );
}
