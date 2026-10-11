import { Pressable } from "react-native";

import { useFreeze, useMe } from "@/api/hooks/me";
import { Icon, Text, toast } from "@/components/ui";
import { confirm } from "@/lib/confirm";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";

import { errorText } from "./error-text";

/**
 * Header freeze button (spec §16 Home). Freezing is instant (I8 tightening); every payment is
 * refused with REFUSE_FROZEN afterwards. Confirmed first because it stops autopay too.
 */
export function FreezeButton() {
  const t = useKassaT();
  const { data: me } = useMe();
  const freeze = useFreeze();
  const frozen = Boolean(me?.frozenAt);

  const onPress = async () => {
    if (frozen) {
      toast.show({
        title: t("home:freeze.alreadyTitle"),
        description: t("home:freeze.alreadyBody"),
      });
      return;
    }
    const ok = await confirm({
      title: t("home:freeze.confirmTitle"),
      message: t("home:freeze.confirmBody"),
      confirmLabel: t("home:freeze.confirm"),
      cancelLabel: t("common:cancel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await freeze.mutateAsync();
      haptics.warning();
      toast.show({ title: t("home:freeze.done"), kind: "success" });
    } catch (err) {
      haptics.error();
      toast.show({ title: errorText(t, err), kind: "error" });
    }
  };

  return (
    <Pressable
      onPress={() => void onPress()}
      accessibilityRole="button"
      accessibilityLabel={frozen ? t("home:freeze.frozenA11y") : t("home:freeze.a11y")}
      hitSlop={8}
      style={{
        minWidth: 44,
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        justifyContent: "center",
      }}
    >
      <Icon
        name="snowflake"
        fallback="ac_unit"
        size={20}
        color={frozen ? "destructive" : "foreground"}
      />
      <Text weight="semibold" color={frozen ? "destructive" : "foreground"}>
        {frozen ? t("home:freeze.frozen") : t("home:freeze.button")}
      </Text>
    </Pressable>
  );
}
