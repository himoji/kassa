import { TabList, TabSlot, TabTrigger, Tabs } from "expo-router/ui";
import { Pressable } from "react-native";

import { useMe } from "@/api/hooks/me";
import { Icon, Text, useTheme } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";

/**
 * Web has no system tab bar (Expo Router docs, "Custom web layout"): headless tabs from
 * expo-router/ui with a bottom bar that mirrors the native one (WAI-ARIA tablist semantics).
 */
const TABS = [
  { name: "home", href: "/home", sf: "house.fill", md: "home", label: "home:tab" },
  {
    name: "chat",
    href: "/chat",
    sf: "bubble.left.and.text.bubble.right.fill",
    md: "forum",
    label: "chat:tab",
  },
  {
    name: "activity",
    href: "/activity",
    sf: "list.bullet.rectangle",
    md: "receipt_long",
    label: "activity:tab",
  },
  { name: "cards", href: "/cards", sf: "creditcard.fill", md: "credit_card", label: "cards:tab" },
  {
    name: "settings",
    href: "/settings",
    sf: "gearshape.fill",
    md: "settings",
    label: "settings:tab",
  },
] as const;

/** (Business M4) The tab set of a BUSINESS account (me.accountType). */
const BUSINESS_TABS = [
  {
    name: "today",
    href: "/today",
    sf: "storefront.fill",
    md: "storefront",
    label: "business:todayTab",
  },
  {
    name: "stock",
    href: "/stock",
    sf: "shippingbox.fill",
    md: "inventory_2",
    label: "business:stockTab",
  },
  {
    name: "orders",
    href: "/orders",
    sf: "doc.text.fill",
    md: "request_quote",
    label: "business:ordersTab",
  },
  {
    name: "chat",
    href: "/chat",
    sf: "bubble.left.and.text.bubble.right.fill",
    md: "forum",
    label: "chat:tab",
  },
  {
    name: "settings",
    href: "/settings",
    sf: "gearshape.fill",
    md: "settings",
    label: "settings:tab",
  },
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
  const me = useMe();
  if (me.isLoading) return null;
  const tabs = me.data?.accountType === "BUSINESS" ? BUSINESS_TABS : TABS;
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
        {tabs.map((tab) => (
          <TabTrigger key={tab.name} name={tab.name} href={tab.href} asChild>
            <TabButton label={t(tab.label)} sf={tab.sf} md={tab.md} />
          </TabTrigger>
        ))}
      </TabList>
    </Tabs>
  );
}
