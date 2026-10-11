import { DemoScenario } from "@kassa/shared";
import { useState } from "react";

import { useMe } from "@/api/hooks/me";
import { useCaptureEvent } from "@/api/hooks/activity";
import { useDemoAction, type DemoAction } from "@/api/hooks/demo";
import { SimulatedBadge } from "@/components/kassa/badges";
import { errorText } from "@/components/kassa/error-text";
import { SettingSwitch } from "@/components/kassa/native-controls";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { RowGroup } from "@/components/row-group";
import { Box, Button, Input, Row, Text, toast } from "@/components/ui";
import { confirm } from "@/lib/confirm";
import { useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";

import { NOTIFICATION_SAMPLES } from "./notification-samples";

/** Demo panel (spec §15): clock, scenarios, agent replay mode, notification simulator, reset. */
export function DemoScreen() {
  const t = useKassaT();
  const f = useFormat();
  const me = useMe();
  const demoAction = useDemoAction();
  const captureEvent = useCaptureEvent();
  const [notifText, setNotifText] = useState("");

  const demo = me.data?.demo ?? null;

  const run = async (action: DemoAction) => {
    try {
      await demoAction.mutateAsync(action);
      haptics.success();
      toast.show({ title: t("demo:done"), kind: "success" });
    } catch (err) {
      haptics.error();
      toast.show({ title: errorText(t, err), kind: "error" });
    }
  };

  const sendNotification = async () => {
    try {
      await captureEvent.mutateAsync({ source: "NOTIF_SIM", rawText: notifText });
      haptics.success();
      toast.show({ title: t("demo:notifSent"), kind: "success" });
    } catch (err) {
      haptics.error();
      toast.show({ title: errorText(t, err), kind: "error" });
    }
  };

  const resetDemo = async () => {
    const ok = await confirm({
      title: t("demo:resetConfirm"),
      confirmLabel: t("demo:reset"),
      cancelLabel: t("common:cancel"),
      destructive: true,
    });
    if (ok) await run({ kind: "reset" });
  };

  return (
    <ScrollScreen>
      <Box gap={3}>
        <SimulatedBadge />
        <Text variant="caption">{t("demo:intro")}</Text>
      </Box>

      <RowGroup title={t("demo:clockTitle")} footer={t("demo:clockFooter")}>
        <Box p={4} gap={3}>
          <Text selectable style={{ fontVariant: ["tabular-nums"] }}>
            {demo ? t("demo:now", { time: f.dateTime(demo.now) }) : t("demo:disabled")}
          </Text>
          <Box row gap={2}>
            <Button
              variant="outline"
              size="md"
              disabled={!demo}
              onPress={() => void run({ kind: "advance", hours: 1 })}
            >
              {t("demo:plus1h")}
            </Button>
            <Button
              variant="outline"
              size="md"
              disabled={!demo}
              onPress={() => void run({ kind: "advance", hours: 24 })}
            >
              {t("demo:plus1d")}
            </Button>
            <Button
              variant="outline"
              size="md"
              disabled={!demo}
              onPress={() => void run({ kind: "advance", hours: 72 })}
            >
              {t("demo:plus3d")}
            </Button>
          </Box>
        </Box>
      </RowGroup>

      <RowGroup title={t("demo:scenariosTitle")}>
        {DemoScenario.options.map((s) => (
          <Row
            key={s}
            title={t(`demo:scenario.${s}`)}
            subtitle={t(`demo:scenarioHint.${s}`)}
            onPress={() => void run({ kind: "trigger", scenario: s })}
          />
        ))}
      </RowGroup>

      <RowGroup title={t("demo:agentTitle")}>
        <SettingSwitch
          label={t("demo:replayMode")}
          description={t("demo:replayHint")}
          value={demo?.agentMode === "REPLAY"}
          disabled={!demo}
          onChange={(on) => void run({ kind: "agent-mode", mode: on ? "REPLAY" : "LIVE" })}
        />
      </RowGroup>

      <RowGroup title={t("demo:notifTitle")} footer={t("demo:notifFooter")}>
        {NOTIFICATION_SAMPLES.map((sample) => (
          <Row
            key={sample.id}
            title={t(sample.labelKey)}
            onPress={() => setNotifText(sample.text)}
          />
        ))}
        <Box p={4} gap={3}>
          <Input
            label={t("demo:notifLabel")}
            value={notifText}
            onChangeText={setNotifText}
            multiline
            autoCapitalize="sentences"
          />
          <Button
            disabled={notifText.trim().length === 0}
            loading={captureEvent.isPending}
            onPress={() => void sendNotification()}
          >
            {t("demo:sendNotif")}
          </Button>
        </Box>
      </RowGroup>

      <RowGroup title={t("demo:resetTitle")}>
        <Box p={4}>
          <Button
            variant="destructive"
            loading={demoAction.isPending}
            onPress={() => void resetDemo()}
          >
            {t("demo:reset")}
          </Button>
        </Box>
      </RowGroup>
    </ScrollScreen>
  );
}
