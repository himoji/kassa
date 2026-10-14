import * as Updates from "expo-updates";
import { useState } from "react";

import { RowGroup } from "@/components/row-group";
import { Box, Button, Text, toast } from "@/components/ui";
import { crash } from "@/lib/crash";
import { useKassaT } from "@/lib/i18n";

/**
 * Settings → App updates (docs/OTA_UPDATES.md): what this build runs (channel, runtime version, embedded
 * bundle or an over-the-air update) and a button that checks, downloads and restarts into a new update
 * right away instead of waiting for the next cold start. Explains instead when updates cannot work here.
 */
export function UpdatesSection() {
  const t = useKassaT();
  const [checking, setChecking] = useState(false);

  if (__DEV__ || !Updates.isEnabled) {
    return (
      <RowGroup title={t("lite:settings.updatesTitle")}>
        <Box p={4}>
          <Text variant="caption">
            {__DEV__ ? t("lite:settings.updatesDebug") : t("lite:settings.updatesOff")}
          </Text>
        </Box>
      </RowGroup>
    );
  }

  const running =
    Updates.isEmbeddedLaunch || !Updates.updateId
      ? t("lite:settings.updatesEmbedded")
      : t("lite:settings.updatesFrom", {
          id: Updates.updateId.slice(0, 8),
          date: Updates.createdAt?.toLocaleString() ?? "?",
        });

  const check = async (): Promise<void> => {
    setChecking(true);
    try {
      const result = await Updates.checkForUpdateAsync();
      if (!result.isAvailable) {
        toast.show({ title: t("lite:settings.updatesNone"), kind: "success" });
        return;
      }
      await Updates.fetchUpdateAsync();
      await Updates.reloadAsync();
    } catch (err) {
      crash.capture(err, { where: "lite-settings.checkForUpdate" });
      const message = err instanceof Error ? err.message : String(err);
      toast.show({ title: t("lite:settings.updatesFailed", { message }), kind: "error" });
    } finally {
      setChecking(false);
    }
  };

  return (
    <RowGroup
      title={t("lite:settings.updatesTitle")}
      footer={t("lite:settings.updatesInfo", {
        channel: Updates.channel ?? "?",
        runtime: Updates.runtimeVersion ?? "?",
        running,
      })}
    >
      <Box p={4}>
        <Button variant="outline" loading={checking} onPress={() => void check()}>
          {checking ? t("lite:settings.updatesChecking") : t("lite:settings.updatesCheck")}
        </Button>
      </Box>
    </RowGroup>
  );
}
