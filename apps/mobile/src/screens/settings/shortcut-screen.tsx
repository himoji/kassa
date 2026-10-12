import { useState, useSyncExternalStore } from "react";

import {
  shortcutEndpoint,
  useCreateShortcutToken,
  useRevokeShortcutDevice,
  useShortcutDevices,
  type ShortcutToken,
} from "@/api/hooks/shortcut";
import { errorText } from "@/components/kassa/error-text";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { RowGroup } from "@/components/row-group";
import { Box, Button, Text, toast } from "@/components/ui";
import { copyToClipboard } from "@/lib/clipboard";
import { confirm } from "@/lib/confirm";
import { useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";

const noSubscribe = () => () => {};

const STEPS = ["1", "2", "3", "4", "5", "6"] as const;

/**
 * Settings → "Apple Pay → Kassa": mint a Shortcut device token (shown once), copy the endpoint, follow the iOS
 * Transaction-automation steps (docs/SHORTCUT_SETUP.md) and revoke tokens. Capture only logs (I6).
 */
export function ShortcutScreen() {
  const t = useKassaT();
  const f = useFormat();
  const devices = useShortcutDevices();
  const create = useCreateShortcutToken();
  const revoke = useRevokeShortcutDevice();
  // The token exists only in this state: the server keeps its hash, never the token (I13).
  const [fresh, setFresh] = useState<ShortcutToken | null>(null);
  // Absolute API URL at first render; the page origin (same-origin web build) only after mount, so the static
  // web render and hydration agree.
  const endpoint = useSyncExternalStore(
    noSubscribe,
    () => shortcutEndpoint(),
    () => shortcutEndpoint(undefined, "")
  );

  const copy = (text: string) => void copyToClipboard(text, { toast: t("shortcut:copied") });

  const onCreate = async () => {
    try {
      setFresh(await create.mutateAsync());
      haptics.success();
    } catch (err) {
      haptics.error();
      toast.show({ title: errorText(t, err), kind: "error" });
    }
  };

  const onRevoke = async (id: string) => {
    const ok = await confirm({
      title: t("shortcut:revokeTitle"),
      message: t("shortcut:revokeBody"),
      confirmLabel: t("shortcut:revoke"),
      cancelLabel: t("common:cancel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await revoke.mutateAsync(id);
      if (fresh?.deviceId === id) setFresh(null);
      haptics.warning();
      toast.show({ title: t("shortcut:revoked"), kind: "success" });
    } catch (err) {
      haptics.error();
      toast.show({ title: errorText(t, err), kind: "error" });
    }
  };

  return (
    <ScrollScreen onRefresh={() => void devices.refetch()} refreshing={devices.isRefetching}>
      <Box gap={3}>
        <Text variant="caption">{t("shortcut:intro")}</Text>
        <Text variant="caption">{t("shortcut:limits")}</Text>
      </Box>

      <RowGroup title={t("shortcut:endpointTitle")} footer={t("shortcut:endpointFooter")}>
        <Box p={4} gap={3}>
          {endpoint ? (
            <>
              <Text variant="code" selectable testID="shortcut-endpoint">
                {endpoint}
              </Text>
              <Button variant="outline" size="sm" onPress={() => copy(endpoint)}>
                {t("shortcut:copyEndpoint")}
              </Button>
            </>
          ) : (
            <Text variant="caption">{t("shortcut:endpointUnknown")}</Text>
          )}
        </Box>
      </RowGroup>

      <RowGroup title={t("shortcut:tokenTitle")} footer={t("shortcut:tokenFooter")}>
        <Box p={4} gap={3}>
          {fresh ? (
            <>
              <Text weight="semibold" color="destructive">
                {t("shortcut:tokenOnce")}
              </Text>
              <Text variant="code" selectable testID="shortcut-token">
                {fresh.token}
              </Text>
              <Button onPress={() => copy(`Bearer ${fresh.token}`)}>
                {t("shortcut:copyHeader")}
              </Button>
              <Button variant="outline" onPress={() => copy(fresh.token)}>
                {t("shortcut:copyToken")}
              </Button>
              <Button variant="ghost" onPress={() => setFresh(null)}>
                {t("shortcut:done")}
              </Button>
            </>
          ) : (
            <Button onPress={() => void onCreate()} loading={create.isPending}>
              {t("shortcut:createToken")}
            </Button>
          )}
        </Box>
      </RowGroup>

      <RowGroup title={t("shortcut:stepsTitle")}>
        <Box p={4} gap={3}>
          {STEPS.map((n) => (
            <Text key={n}>{t("shortcut:step", { n, text: t(`shortcut:steps.${n}`) })}</Text>
          ))}
        </Box>
      </RowGroup>

      <QueryView query={devices} skeletonRows={1}>
        {(d) => (
          <RowGroup
            title={t("shortcut:devicesTitle")}
            footer={
              d.lastCaptureAt
                ? t("shortcut:lastCapture", { time: f.dateTime(d.lastCaptureAt) })
                : t("shortcut:noCapture")
            }
          >
            {d.devices.length === 0 ? (
              <Box p={4}>
                <Text variant="caption">{t("shortcut:devicesEmpty")}</Text>
              </Box>
            ) : null}
            {d.devices.map((device) => (
              <Box key={device.id} p={4} row justify="between" align="center" gap={3}>
                <Box gap={1} style={{ flexShrink: 1 }}>
                  <Text weight="semibold">{t("shortcut:title")}</Text>
                  <Text variant="caption">
                    {t("shortcut:deviceCreated", { date: f.dateTime(device.createdAt) })}
                  </Text>
                  <Text variant="caption" selectable>
                    {device.id.slice(0, 8)}
                  </Text>
                </Box>
                <Button
                  variant="destructive"
                  size="sm"
                  onPress={() => void onRevoke(device.id)}
                  loading={revoke.isPending && revoke.variables === device.id}
                >
                  {t("shortcut:revoke")}
                </Button>
              </Box>
            ))}
          </RowGroup>
        )}
      </QueryView>
    </ScrollScreen>
  );
}
