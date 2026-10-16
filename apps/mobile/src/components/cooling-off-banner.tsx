/**
 * Shown on every screen while this user has the demo's 24 h waits off (MeResponse.demo.coolingOff, POST /demo/cooling):
 * nobody should forget that a new recipient is payable at once. "Turn on" needs no passkey (it tightens).
 */
import { useMe } from "@/api/hooks/me";
import { useDemoCooling } from "@/api/hooks/demo";
import { Box, Button, Text } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export function CoolingOffBanner() {
  const t = useKassaT();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const cooling = useDemoCooling();
  if (!me.data?.demo?.coolingOff) return null;
  return (
    <Box
      row
      align="center"
      justify="between"
      gap={2}
      px={4}
      py={2}
      bg="destructive"
      style={{ paddingTop: insets.top + 8 }}
    >
      <Text variant="caption" color="destructiveForeground" style={{ flexShrink: 1 }}>
        {t("demo:coolingBanner")}
      </Text>
      <Button
        size="sm"
        variant="secondary"
        loading={cooling.isPending}
        onPress={() => cooling.mutate(true)}
      >
        {t("demo:coolingBannerAction")}
      </Button>
    </Box>
  );
}
