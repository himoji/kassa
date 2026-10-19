import { TabList, TabSlot, TabTrigger, Tabs } from "expo-router/ui";
import { Pressable, useWindowDimensions, View } from "react-native";

import { useMe } from "@/api/hooks/me";
import { Logo } from "@/components/kassa/logo";
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
  side,
  ...rest
}: {
  label: string;
  sf: string;
  md: string;
  isFocused?: boolean;
  side?: boolean;
  onPress?: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      {...rest}
      accessibilityRole="tab"
      accessibilityState={{ selected: Boolean(isFocused) }}
      style={({ hovered }: { hovered?: boolean }) =>
        side
          ? {
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingHorizontal: 12,
              height: 42,
              borderRadius: 10,
              backgroundColor: isFocused ? colors.accent : hovered ? colors.muted : "transparent",
            }
          : { flex: 1, minHeight: 56, alignItems: "center", justifyContent: "center", gap: 3 }
      }
    >
      <Icon
        name={sf}
        fallback={md}
        size={side ? 20 : 22}
        color={isFocused ? "brandAccent" : "mutedForeground"}
      />
      <Text
        variant="label"
        color={isFocused ? (side ? "foreground" : "brandAccent") : "mutedForeground"}
        style={side ? { fontSize: 15, fontWeight: isFocused ? "600" : "500" } : { fontSize: 11 }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Wide screens get a sidebar and a centred content column; phones keep the bottom bar. */
export default function WebTabsLayout() {
  const t = useKassaT();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const me = useMe();
  if (me.isLoading) return null;
  const tabs = me.data?.accountType === "BUSINESS" ? BUSINESS_TABS : TABS;
  const wide = width >= 900;
  // TabList must stay a direct child of Tabs (expo-router/ui reads the triggers from it).
  const list = (
    <TabList
      style={
        wide
          ? {
              flexDirection: "column",
              justifyContent: "flex-start",
              width: 248,
              gap: 4,
              paddingHorizontal: 16,
              paddingVertical: 24,
              borderRightWidth: 1,
              borderRightColor: colors.border,
              backgroundColor: colors.card,
            }
          : {
              flexDirection: "row",
              borderTopWidth: 1,
              borderTopColor: colors.border,
              backgroundColor: colors.card,
              paddingBottom: "env(safe-area-inset-bottom)" as unknown as number,
            }
      }
    >
      {wide ? (
        <View style={{ paddingHorizontal: 8, paddingBottom: 24 }}>
          <Logo size={30} />
        </View>
      ) : null}
      {tabs.map((tab) => (
        <TabTrigger key={tab.name} name={tab.name} href={tab.href} asChild>
          <TabButton side={wide} label={t(tab.label)} sf={tab.sf} md={tab.md} />
        </TabTrigger>
      ))}
    </TabList>
  );
  return (
    <Tabs
      style={{
        flex: 1,
        flexDirection: wide ? "row" : "column",
        backgroundColor: colors.background,
      }}
    >
      {wide ? list : null}
      <TabSlot style={{ flex: 1 }} />
      {wide ? null : list}
    </Tabs>
  );
}
