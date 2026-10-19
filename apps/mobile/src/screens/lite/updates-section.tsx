import * as Updates from "expo-updates";
import { useState } from "react";

import { RowGroup } from "@/components/row-group";
import { Box, Button, Icon, Row, Text, toast } from "@/components/ui";
import { crash } from "@/lib/crash";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

/**
 * Stamped into the bundle by `bun run ota` (scripts/ota.ts) when it publishes: the update's message and the git
 * commit it was built from. Absent in the bundle Xcode builds. Spelled out statically so Expo inlines them.
 */
const OTA_MESSAGE = process.env.EXPO_PUBLIC_OTA_MESSAGE || undefined;
const OTA_COMMIT = process.env.EXPO_PUBLIC_OTA_COMMIT || undefined;

/**
 * Settings → App updates (docs/guide/ota-updates.md): which bundle this build runs (the bundle built in Xcode, or an
 * over-the-air update with its id, publish date, message and commit), the channel and app version, and a button
 * that checks, downloads and restarts into a new update right away instead of waiting for the next cold start.
 * Explains instead when updates cannot work here.
 */
export function UpdatesSection() {
  const t = useKassaT();
  const f = useFormat();
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

  const updateId = Updates.isEmbeddedLaunch ? null : Updates.updateId;
  const embedded = !updateId;
  const title = updateId
    ? t("lite:settings.updatesRunning", { id: updateId.slice(0, 8) })
    : t("lite:settings.updatesEmbedded");
  const details = embedded
    ? [t("lite:settings.updatesEmbeddedHint")]
    : [
        [
          Updates.createdAt ? f.dateTime(Updates.createdAt.toISOString()) : undefined,
          OTA_COMMIT ? t("lite:settings.updatesCommit", { commit: OTA_COMMIT }) : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        OTA_MESSAGE,
      ].filter(Boolean);

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
      icons
      footer={t("lite:settings.updatesInfo", {
        channel: Updates.channel ?? "?",
        runtime: Updates.runtimeVersion ?? "?",
      })}
    >
      <Row
        testID="updates-running"
        leading={
          <Icon
            name={embedded ? "hammer.fill" : "arrow.down.circle.fill"}
            fallback={embedded ? "build" : "downloading"}
            size={24}
            color="brandAccent"
          />
        }
        title={title}
        subtitle={details.join("\n")}
      />
      <Box p={4}>
        <Button variant="outline" loading={checking} onPress={() => void check()}>
          {checking ? t("lite:settings.updatesChecking") : t("lite:settings.updatesCheck")}
        </Button>
      </Box>
    </RowGroup>
  );
}
