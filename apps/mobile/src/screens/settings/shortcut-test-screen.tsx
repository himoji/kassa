import { router } from "expo-router";
import { useEffect, useState } from "react";

import { shortcutEndpoint, useShortcutDevices, type ShortcutAttempt } from "@/api/hooks/shortcut";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { RowGroup } from "@/components/row-group";
import { Box, Button, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { isLiteBuild } from "@/lite/variant";
import {
  attemptsSince,
  attemptVerdict,
  fromScript,
  NOTHING_ARRIVED_AFTER_MS,
  testState,
  type Answers,
  type Tone,
} from "@/lib/shortcut-test";

const POLL_MS = 3000;
const NO_ANSWERS: Answers = { amountMatches: null, notificationShown: null };
const TONE_COLOR: Record<Tone, "success" | "destructive" | "foreground"> = {
  ok: "success",
  fix: "destructive",
  info: "foreground",
};
const NOTHING_REASONS = ["1", "2", "3", "4", "5"] as const;

/**
 * Settings → Payment taps → "Test it live" (lib/shortcut-test.ts): start, pay with Apple Pay, and see every request
 * the Shortcut made since then, refused ones included, read from the server (GET /devices `recentChecks`). It passes
 * only on a logged purchase from the Shortcuts app that the person confirms is theirs and that showed the notification.
 */
export function ShortcutTestScreen() {
  const t = useKassaT();
  const f = useFormat();
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [startedMs, setStartedMs] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [answers, setAnswers] = useState<Answers>(NO_ANSWERS);
  const devices = useShortcutDevices(startedAt ? POLL_MS : false);

  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const start = async () => {
    // The server's clock decides what counts as "after the start", not the phone's.
    const fresh = await devices.refetch();
    setStartedAt(fresh.data?.serverTime ?? new Date().toISOString());
    setStartedMs(Date.now());
    setAnswers(NO_ANSWERS);
    haptics.selection();
  };

  const since = startedAt ? attemptsSince(devices.data?.recentChecks, startedAt) : [];
  const state = testState(since, answers);
  const elapsed = Math.max(0, Math.round((now - startedMs) / 1000));
  const endpoint = shortcutEndpoint();

  return (
    <ScrollScreen onRefresh={() => void devices.refetch()} refreshing={devices.isRefetching}>
      <Text variant="caption">{t("shortcut:test.intro")}</Text>

      <QueryView query={devices} skeletonRows={1}>
        {(d) => (
          <RowGroup title={t("shortcut:test.keysTitle")} footer={t("shortcut:test.keysFooter")}>
            <Box p={4} gap={3}>
              {d.recentChecks === undefined ? (
                <Text color="destructive">{t("shortcut:test.oldServer")}</Text>
              ) : d.devices.length === 0 ? (
                <>
                  <Text color="destructive">{t("shortcut:test.noKey")}</Text>
                  {isLiteBuild() ? null : (
                    <Button variant="outline" size="sm" onPress={() => router.push("/shortcut")}>
                      {t("shortcut:test.createKey")}
                    </Button>
                  )}
                </>
              ) : (
                <Text>
                  {t("shortcut:test.keys", {
                    n: d.devices.length,
                    last: d.lastUsedAt ? f.dateTime(d.lastUsedAt) : t("shortcut:test.never"),
                  })}
                </Text>
              )}
              {endpoint ? (
                <Text variant="caption" selectable>
                  {t("shortcut:test.endpoint", { url: endpoint })}
                </Text>
              ) : null}
            </Box>
          </RowGroup>
        )}
      </QueryView>

      <RowGroup title={t("shortcut:test.runTitle")}>
        <Box p={4} gap={3}>
          {startedAt ? (
            <>
              <Text weight="semibold">{t("shortcut:test.running", { seconds: elapsed })}</Text>
              <Text>{t("shortcut:test.payNow")}</Text>
              <Button variant="outline" size="sm" onPress={() => void start()}>
                {t("shortcut:test.restart")}
              </Button>
            </>
          ) : (
            <>
              <Text>{t("shortcut:test.before")}</Text>
              <Button onPress={() => void start()}>{t("shortcut:test.start")}</Button>
            </>
          )}
        </Box>
      </RowGroup>

      {startedAt ? (
        <RowGroup title={t("shortcut:test.resultTitle")}>
          <Box p={4} gap={3} testID={`shortcut-test-state-${state.kind}`}>
            {state.kind === "waiting" ? (
              <>
                <Text>{t("shortcut:test.state.waiting")}</Text>
                {now - startedMs > NOTHING_ARRIVED_AFTER_MS ? (
                  <Box gap={2}>
                    <Text weight="semibold" color="destructive">
                      {t("shortcut:test.nothing.title")}
                    </Text>
                    {NOTHING_REASONS.map((n) => (
                      <Text key={n} variant="caption">
                        {t("shortcut:step", { n, text: t(`shortcut:test.nothing.${n}`) })}
                      </Text>
                    ))}
                  </Box>
                ) : null}
              </>
            ) : state.kind === "fix" ? (
              <Text weight="semibold" color="destructive">
                {t("shortcut:test.state.fix", {
                  problem: t(`shortcut:test.attempt.${state.verdict.key}`, {
                    problem: state.attempt.problem ?? "",
                  }),
                })}
              </Text>
            ) : state.kind === "manualOnly" ? (
              <Text weight="semibold">{t("shortcut:test.state.manualOnly")}</Text>
            ) : state.kind === "notShortcuts" ? (
              <Text weight="semibold" color="destructive">
                {t("shortcut:test.state.notShortcuts", { client: state.attempt.client ?? "?" })}
              </Text>
            ) : state.kind === "passed" ? (
              <Text weight="semibold" color="success">
                {t("shortcut:test.state.passed")}
              </Text>
            ) : state.kind === "wrongAmount" ? (
              <Text weight="semibold" color="destructive">
                {t("shortcut:test.state.wrongAmount")}
              </Text>
            ) : state.kind === "noNotification" ? (
              <Text weight="semibold" color="destructive">
                {t(
                  state.attempt.via === "action"
                    ? "shortcut:test.state.noNotificationAction"
                    : "shortcut:test.state.noNotification"
                )}
              </Text>
            ) : (
              <>
                <Text weight="semibold">{t("shortcut:test.state.confirm")}</Text>
                <Purchase attempt={state.attempt} />
                <Question
                  label={t("shortcut:test.askAmount")}
                  value={answers.amountMatches}
                  onAnswer={(v) => setAnswers((a) => ({ ...a, amountMatches: v }))}
                />
                <Question
                  label={t("shortcut:test.askNotification", {
                    title: state.attempt.replyTitle ?? "Kassa",
                  })}
                  value={answers.notificationShown}
                  onAnswer={(v) => setAnswers((a) => ({ ...a, notificationShown: v }))}
                />
              </>
            )}
            {state.kind !== "waiting" && state.kind !== "confirm" && state.kind !== "passed" ? (
              <Text variant="caption">{t("shortcut:test.tryAgain")}</Text>
            ) : null}
          </Box>
        </RowGroup>
      ) : null}

      {startedAt && since.length > 0 ? (
        <RowGroup
          title={t("shortcut:test.logTitle", { n: since.length })}
          footer={t("shortcut:test.logFooter")}
        >
          {since.map((a) => (
            <AttemptRow key={`${a.deviceId}:${a.at}`} attempt={a} />
          ))}
        </RowGroup>
      ) : null}
    </ScrollScreen>
  );
}

function Purchase({ attempt }: { attempt: ShortcutAttempt }) {
  const t = useKassaT();
  const f = useFormat();
  if (!attempt.payment) return null;
  return (
    <Text variant="code" selectable>
      {t("shortcut:test.purchase", {
        merchant: attempt.payment.merchant,
        amount: f.money(attempt.payment.amountMinor, attempt.payment.currency),
        time: f.dateTime(attempt.at),
      })}
    </Text>
  );
}

function Question({
  label,
  value,
  onAnswer,
}: {
  label: string;
  value: boolean | null;
  onAnswer: (v: boolean) => void;
}) {
  const t = useKassaT();
  return (
    <Box gap={2}>
      <Text>{label}</Text>
      <Box row gap={2}>
        <Button
          size="sm"
          variant={value === true ? "primary" : "outline"}
          onPress={() => onAnswer(true)}
        >
          {t("shortcut:test.yes")}
        </Button>
        <Button
          size="sm"
          variant={value === false ? "destructive" : "outline"}
          onPress={() => onAnswer(false)}
        >
          {t("shortcut:test.no")}
        </Button>
      </Box>
    </Box>
  );
}

function AttemptRow({ attempt }: { attempt: ShortcutAttempt }) {
  const t = useKassaT();
  const f = useFormat();
  const v = attemptVerdict(attempt);
  const mark = (ok: boolean) => (ok ? "✓" : "✗");
  return (
    <Box p={4} gap={1}>
      <Text weight="semibold" color={TONE_COLOR[v.tone]}>
        {t(`shortcut:test.attempt.${v.key}`, { problem: attempt.problem ?? "" })}
      </Text>
      <Text variant="caption">
        {t("shortcut:test.attemptMeta", {
          time: f.dateTime(attempt.at),
          client: attempt.via === "action" ? t("shortcut:test.viaAction") : (attempt.client ?? "?"),
        })}
      </Text>
      {attempt.kind !== "REVOKED_KEY" ? (
        <Text variant="caption">
          {t("shortcut:test.fields", {
            merchant: mark(attempt.fields.merchant),
            amount: mark(attempt.fields.amount),
            card: mark(attempt.fields.card),
            place: mark(attempt.fields.place),
          })}
        </Text>
      ) : null}
      {attempt.payment ? <Purchase attempt={attempt} /> : null}
      {fromScript(attempt) ? (
        <Text variant="caption" color="destructive">
          {t("shortcut:test.scriptClient")}
        </Text>
      ) : null}
    </Box>
  );
}
