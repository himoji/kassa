import { NativeTabs } from "expo-router/unstable-native-tabs";
import { Children, type ReactElement, type ReactNode } from "react";
import { I18nManager } from "react-native";

import { useNotifications } from "@/api/hooks/activity";
import { useMe } from "@/api/hooks/me";
import { usePendingProposals } from "@/api/hooks/money";
import { useTheme } from "@/components/ui";
import { useRegisterDevice } from "@/hooks/use-register-device";
import { useKassaT } from "@/lib/i18n";

/**
 * The platform's own tab bar: UITabBar on iOS (Liquid Glass on iOS 26, minimizes while
 * scrolling) and Material 3 navigation on Android. Icons are SF Symbols (`sf`) with a
 * Material Symbols fallback (`md`). Web uses `_layout.web.tsx`.
 *
 * (Business M4) A BUSINESS account (me.accountType) gets Today, Stock, Orders, Chat, Settings; the personal tabs
 * are hidden, and the business ones are hidden for everyone else. Nothing renders until /me is known, so the
 * navigator never remounts when the tab set would change.
 */
function inReadingOrder(tabs: ReactElement<{ children?: ReactNode }>): ReactNode[] {
  const items = Children.toArray(tabs.props.children);
  return I18nManager.isRTL ? items.reverse() : items;
}

export default function TabsLayout() {
  const { colors } = useTheme();
  const t = useKassaT();
  const pending = usePendingProposals().data?.proposals.length ?? 0;
  const unread = useNotifications().data?.unread ?? 0;
  const me = useMe();
  useRegisterDevice();
  if (me.isLoading) return null;
  const business = me.data?.accountType === "BUSINESS";

  return (
    <NativeTabs tintColor={colors.brandAccent} minimizeBehavior="onScrollDown">
      {inReadingOrder(
        <>
          <NativeTabs.Trigger name="today" hidden={!business}>
            <NativeTabs.Trigger.Icon
              sf={{ default: "storefront", selected: "storefront.fill" }}
              md="storefront"
            />
            <NativeTabs.Trigger.Label>{t("business:todayTab")}</NativeTabs.Trigger.Label>
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="stock" hidden={!business}>
            <NativeTabs.Trigger.Icon
              sf={{ default: "shippingbox", selected: "shippingbox.fill" }}
              md="inventory_2"
            />
            <NativeTabs.Trigger.Label>{t("business:stockTab")}</NativeTabs.Trigger.Label>
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="orders" hidden={!business}>
            <NativeTabs.Trigger.Icon
              sf={{ default: "doc.text", selected: "doc.text.fill" }}
              md="request_quote"
            />
            <NativeTabs.Trigger.Label>{t("business:ordersTab")}</NativeTabs.Trigger.Label>
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="home" hidden={business}>
            <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} md="home" />
            <NativeTabs.Trigger.Label>{t("home:tab")}</NativeTabs.Trigger.Label>
            {pending > 0 ? (
              <NativeTabs.Trigger.Badge>{String(pending)}</NativeTabs.Trigger.Badge>
            ) : null}
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="chat">
            <NativeTabs.Trigger.Icon
              sf={{
                default: "bubble.left.and.text.bubble.right",
                selected: "bubble.left.and.text.bubble.right.fill",
              }}
              md="forum"
            />
            <NativeTabs.Trigger.Label>{t("chat:tab")}</NativeTabs.Trigger.Label>
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="activity" hidden={business}>
            <NativeTabs.Trigger.Icon sf="list.bullet.rectangle" md="receipt_long" />
            <NativeTabs.Trigger.Label>{t("activity:tab")}</NativeTabs.Trigger.Label>
            {unread > 0 ? <NativeTabs.Trigger.Badge /> : null}
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="cards" hidden={business}>
            <NativeTabs.Trigger.Icon
              sf={{ default: "creditcard", selected: "creditcard.fill" }}
              md="credit_card"
            />
            <NativeTabs.Trigger.Label>{t("cards:tab")}</NativeTabs.Trigger.Label>
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="settings">
            <NativeTabs.Trigger.Icon sf="gearshape.fill" md="settings" />
            <NativeTabs.Trigger.Label>{t("settings:tab")}</NativeTabs.Trigger.Label>
          </NativeTabs.Trigger>
        </>
      )}
    </NativeTabs>
  );
}
