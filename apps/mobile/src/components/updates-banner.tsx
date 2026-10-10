/**
 * "Update ready" banner for expo-updates (Phase 6 always-on extra).
 *
 * Downloads an available OTA update in the background and, once it is
 * pending, offers a restart. Also re-checks when the app returns to the
 * foreground (throttled). Renders nothing in dev, when updates are disabled
 * (Expo Go, no `updates.url`) or when `features.updatesBanner` is off.
 */
import * as Updates from "expo-updates";
import { useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { crash } from "@/lib/crash";
import { readynative } from "@/lib/readynative";
import { useT } from "@/lib/i18n";
import { Box, Button, Text } from "@/components/ui";

/** Minimum gap between foreground `checkForUpdateAsync()` calls. */
const FOREGROUND_CHECK_INTERVAL_MS = 5 * 60 * 1000;

function isBannerEnabled(): boolean {
  return readynative.features.updatesBanner && Updates.isEnabled && !__DEV__;
}

export function UpdatesBanner() {
  if (!isBannerEnabled()) return null;
  return <UpdatesBannerInner />;
}

/** Split so the hooks only run when the banner can actually do something. */
function UpdatesBannerInner() {
  const t = useT();
  const insets = useSafeAreaInsets();
  const { isUpdateAvailable, isUpdatePending, isDownloading } = Updates.useUpdates();
  const [dismissed, setDismissed] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const fetchStarted = useRef(false);
  const lastCheckAt = useRef(0);

  // Download once per available update; `useUpdates` flips `isUpdatePending` when done.
  useEffect(() => {
    if (!isUpdateAvailable || isUpdatePending || isDownloading || fetchStarted.current) return;
    fetchStarted.current = true;
    Updates.fetchUpdateAsync().catch((err: unknown) => {
      crash.capture(err, { where: "updates-banner.fetchUpdateAsync" });
    });
  }, [isUpdateAvailable, isUpdatePending, isDownloading]);

  useEffect(() => {
    const onChange = (status: AppStateStatus): void => {
      if (status !== "active") return;
      const now = Date.now();
      if (now - lastCheckAt.current < FOREGROUND_CHECK_INTERVAL_MS) return;
      lastCheckAt.current = now;
      Updates.checkForUpdateAsync().catch((err: unknown) => {
        crash.capture(err, { where: "updates-banner.checkForUpdateAsync" });
      });
    };
    const sub = AppState.addEventListener("change", onChange);
    return () => sub.remove();
  }, []);

  if (!isUpdatePending || dismissed) return null;

  const restart = (): void => {
    setRestarting(true);
    Updates.reloadAsync().catch((err: unknown) => {
      crash.capture(err, { where: "updates-banner.reloadAsync" });
      setRestarting(false);
    });
  };

  return (
    <Box
      row
      align="center"
      gap={3}
      px={4}
      py={3}
      bg="card"
      border
      style={{ paddingTop: insets.top + 12 }}
    >
      <Box flex={1} gap={1}>
        <Text weight="semibold">{t("Update ready")}</Text>
        <Text variant="caption">{t("Restart to apply the latest version.")}</Text>
      </Box>
      <Button size="sm" variant="ghost" onPress={() => setDismissed(true)}>
        {t("Later")}
      </Button>
      <Button size="sm" variant="primary" loading={restarting} onPress={restart}>
        {t("Restart")}
      </Button>
    </Box>
  );
}
