import { NativeTabs } from "expo-router/unstable-native-tabs";

import { useTheme } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";

export default function LiteTabsLayout() {
  const { colors } = useTheme();
  const t = useKassaT();
  return (
    <NativeTabs tintColor={colors.brandAccent}>
      <NativeTabs.Trigger name="activity">
        <NativeTabs.Trigger.Icon sf="list.bullet.rectangle" md="receipt_long" />
        <NativeTabs.Trigger.Label>{t("lite:tabs.activity")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="insights">
        <NativeTabs.Trigger.Icon
          sf={{ default: "chart.bar", selected: "chart.bar.fill" }}
          md="insights"
        />
        <NativeTabs.Trigger.Label>{t("lite:tabs.insights")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="chat">
        <NativeTabs.Trigger.Icon
          sf={{
            default: "bubble.left.and.text.bubble.right",
            selected: "bubble.left.and.text.bubble.right.fill",
          }}
          md="forum"
        />
        <NativeTabs.Trigger.Label>{t("lite:tabs.chat")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon sf="gearshape.fill" md="settings" />
        <NativeTabs.Trigger.Label>{t("lite:tabs.settings")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
