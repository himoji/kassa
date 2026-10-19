import { DemoScenario } from "@kassa/shared";
import { useState } from "react";

import { useMe } from "@/api/hooks/me";
import { useCaptureEvent } from "@/api/hooks/activity";
import { useDemoAvailability } from "@/api/hooks/auth";
import { useDemoAction, useDemoCooling, useMoneyFromHome, type DemoAction } from "@/api/hooks/demo";
import { SimulatedBadge } from "@/components/kassa/badges";
import { errorText } from "@/components/kassa/error-text";
import { SettingSwitch } from "@/components/kassa/native-controls";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { RowGroup } from "@/components/row-group";
import { Box, Button, Input, Row, Text, toast } from "@/components/ui";
import { confirm } from "@/lib/confirm";
import { env } from "@/lib/env";
import { useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { PasskeyCancelledError } from "@/lib/passkey-errors";

import { NOTIFICATION_SAMPLES } from "./notification-samples";

/**
 * Demo panel (spec §15): clock, scenarios, agent replay mode, notification simulator, reset. The shared-world controls
 * need the demo admin token (or a dev build); the judge build shows the user's own actions only: money from home into
 * their own wallet, their 24 h waits and the notification simulator.
 */
export function DemoScreen() {
  const t = useKassaT();
  const f = useFormat();
  const me = useMe();
  const demoAction = useDemoAction();
  const captureEvent = useCaptureEvent();
  const cooling = useDemoCooling();
  const moneyFromHome = useMoneyFromHome();
  const availability = useDemoAvailability();
  const [notifText, setNotifText] = useState("");
  const admin = Boolean(env.DEMO_ADMIN_TOKEN) || __DEV__;
  const ownMoney = availability.data?.judgeMode === true || __DEV__;

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

  const setCooling = async (on: boolean) => {
    try {
      await cooling.mutateAsync(on);
      haptics.success();
      toast.show({ title: t(on ? "demo:coolingOnDone" : "demo:coolingOffDone"), kind: "success" });
    } catch (err) {
      if (err instanceof PasskeyCancelledError) return;
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

  const sendMoneyFromHome = async () => {
    try {
      const r = await moneyFromHome.mutateAsync();
      haptics.success();
      toast.show({
        title: t("demo:homeDone", { amount: f.money(r.amountMinor, r.currency) }),
        kind: "success",
      });
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

      {ownMoney ? (
        <RowGroup title={t("demo:homeTitle")} footer={t("demo:homeFooter")}>
          <Box p={4}>
            <Button loading={moneyFromHome.isPending} onPress={() => void sendMoneyFromHome()}>
              {t("demo:homeSend")}
            </Button>
          </Box>
        </RowGroup>
      ) : null}

      {admin ? (
        <RowGroup title={t("demo:clockTitle")} footer={t("demo:clockFooter")}>
          <Box p={4} gap={3}>
            <SettingSwitch
              label={t("demo:demoTime")}
              description={t("demo:demoTimeHint")}
              value={demo?.clockMode === "DEMO"}
              disabled={!demo}
              onChange={(on) => void run({ kind: "clock-mode", mode: on ? "DEMO" : "REAL" })}
            />
            <Text selectable style={{ fontVariant: ["tabular-nums"] }}>
              {demo
                ? t(demo.clockMode === "DEMO" ? "demo:nowDemo" : "demo:nowReal", {
                    time: f.dateTime(demo.now),
                  })
                : t("demo:disabled")}
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
      ) : null}

      {admin ? (
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
      ) : null}

      <RowGroup title={t("demo:coolingTitle")} footer={t("demo:coolingFooter")}>
        <SettingSwitch
          label={t("demo:cooling")}
          description={t("demo:coolingHint")}
          value={!demo?.coolingOff}
          disabled={!demo || cooling.isPending}
          onChange={(on) => void setCooling(on)}
        />
      </RowGroup>

      {admin ? (
        <RowGroup title={t("demo:agentTitle")}>
          <SettingSwitch
            label={t("demo:replayMode")}
            description={t("demo:replayHint")}
            value={demo?.agentMode === "REPLAY"}
            disabled={!demo}
            onChange={(on) => void run({ kind: "agent-mode", mode: on ? "REPLAY" : "LIVE" })}
          />
        </RowGroup>
      ) : null}

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

      {admin ? (
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
      ) : null}
    </ScrollScreen>
  );
}
