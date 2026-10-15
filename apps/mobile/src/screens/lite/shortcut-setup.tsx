import { useEffect, useRef, useState, type ReactNode } from "react";
import { Linking, Pressable } from "react-native";

import { useShortcutDevices } from "@/api/hooks/shortcut";
import { errorText } from "@/components/kassa/error-text";
import { RowGroup } from "@/components/row-group";
import { Box, Button, Icon, Spinner, Text, toast, useTheme } from "@/components/ui";
import { copyToClipboard } from "@/lib/clipboard";
import { useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { loadServerUrl, shortcutEndpointFor } from "@/lite/server-url";
import {
  checkShortcutConnection,
  EMPTY_PROGRESS,
  loadSetupProgress,
  movedSince,
  saveSetupProgress,
  shortcutRunUrl,
  type ConnectionCheck,
  type SetupProgress,
} from "@/lite/shortcut-check";
import { loadShortcutToken } from "@/lite/shortcut-token";
import { shortcutTemplateUrl } from "@/lite/variant";

const BUILD_STEPS = ["1", "2", "3", "4", "5"] as const;
/** How long "Run test" waits for the Shortcut to reach the server. */
const RUN_TIMEOUT_MS = 45_000;

/** What the person pastes into the Shortcut: the endpoint, then the Authorization header value. */
export function shortcutClipboardText(serverUrl: string, token: string): string {
  return `${shortcutEndpointFor(serverUrl)}\nBearer ${token}`;
}

/** "kassa-sand.vercel.app" for the stored `https://` origin. */
export function serverHost(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

type Test =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "running"; baseline: string | null; until: number }
  | { phase: "awaitingPurchase" }
  | { phase: "timeout" }
  | { phase: "error"; result: Exclude<ConnectionCheck, "ok"> };

/**
 * KassaLite Settings → "Apple Pay Shortcut": a checklist that ends in proof. With a Shortcut template link
 * (`extra.shortcutTemplateUrl`) it is copy setup → get the Shortcut → automation → "Run test" (runs the Shortcut
 * once through Shortcuts' x-callback URL and waits for the server to see it); without one, copy URL/key → build the
 * automation → "Check connection" (the app posts a test with the same key) and the first purchase. The status card
 * on top turns green once the server has heard from the Shortcut (GET /devices `lastUsedAt`, or a logged purchase).
 */
export function ShortcutSetup() {
  const t = useKassaT();
  const f = useFormat();
  const { colors } = useTheme();
  const template = shortcutTemplateUrl();
  const [progress, setProgress] = useState<SetupProgress>(EMPTY_PROGRESS);
  const [server, setServer] = useState<string | null>(null);
  const [rawTest, setTest] = useState<Test>({ phase: "idle" });
  const [showBuild, setShowBuild] = useState(false);
  // Poll GET /devices while waiting; `rawTest` is what was started, `test` what is still pending.
  const [pollMs, setPollMs] = useState<number | false>(false);
  const devices = useShortcutDevices(pollMs);
  const lastUsedAt = devices.data?.lastUsedAt ?? null;
  const lastCaptureAt = devices.data?.lastCaptureAt ?? null;
  const connected = Boolean(lastUsedAt ?? lastCaptureAt);
  // A wait ends once the server has heard from the Shortcut: since the test began, or at all for the first purchase.
  const ranNow = rawTest.phase === "running" && movedSince(lastUsedAt, rawTest.baseline);
  const test: Test =
    ranNow || (rawTest.phase === "awaitingPurchase" && connected) ? { phase: "idle" } : rawTest;
  const waiting = test.phase === "running" || test.phase === "awaitingPurchase";
  const wantPoll =
    test.phase === "running" ? 2000 : test.phase === "awaitingPurchase" ? 5000 : false;
  if (wantPoll !== pollMs) setPollMs(wantPoll);

  useEffect(() => {
    void loadSetupProgress().then(setProgress);
    void loadServerUrl().then(setServer);
  }, []);

  const update = (patch: Partial<SetupProgress>) => {
    setProgress((p) => {
      const next = { ...p, ...patch };
      void saveSetupProgress(next);
      return next;
    });
  };

  // Proof, said out loud: a success haptic and toast when the test run lands or the Shortcut reports in for the
  // first time while this screen is open (not on every launch of an already working setup).
  const celebrated = useRef(false);
  const wasConnected = useRef<boolean | null>(null);
  useEffect(() => {
    if (!devices.data) return;
    const before = wasConnected.current;
    wasConnected.current = connected;
    if ((ranNow || (before === false && connected)) && !celebrated.current) {
      celebrated.current = true;
      haptics.success();
      toast.show({ title: t("lite:settings.setup.test.success"), kind: "success" });
    }
  }, [devices.data, connected, ranNow, t]);

  // "Run test" gives up after RUN_TIMEOUT_MS without a word from the Shortcut.
  const runUntil = test.phase === "running" ? test.until : null;
  useEffect(() => {
    if (runUntil === null) return;
    const timer = setTimeout(
      () => setTest((cur) => (cur.phase === "running" ? { phase: "timeout" } : cur)),
      Math.max(0, runUntil - Date.now())
    );
    return () => clearTimeout(timer);
  }, [runUntil]);

  const credentials = async (): Promise<{ server: string; token: string } | null> => {
    const [token, stored] = await Promise.all([loadShortcutToken(), loadServerUrl()]);
    if (!token || !stored) {
      haptics.error();
      toast.show({ title: t("lite:settings.setup.copy.noToken"), kind: "error" });
      return null;
    }
    return { server: stored, token };
  };

  const copy = async (what: "both" | "url" | "header") => {
    const c = await credentials();
    if (!c) return;
    const text =
      what === "url"
        ? shortcutEndpointFor(c.server)
        : what === "header"
          ? `Bearer ${c.token}`
          : shortcutClipboardText(c.server, c.token);
    const key = what === "url" ? "copiedUrl" : what === "header" ? "copiedHeader" : "copied";
    await copyToClipboard(text, { toast: t(`lite:settings.setup.copy.${key}`) });
    haptics.selection();
    update({ copied: true });
  };

  const open = async (url: string, patch: Partial<SetupProgress>) => {
    try {
      await Linking.openURL(url);
      update(patch);
    } catch (err) {
      toast.show({ title: errorText(t, err), kind: "error" });
    }
  };

  const runTest = async () => {
    const c = await credentials();
    if (!c) return;
    setTest({ phase: "checking" });
    const result = await checkShortcutConnection(c.server, c.token);
    if (result !== "ok") {
      haptics.error();
      setTest({ phase: "error", result });
      return;
    }
    celebrated.current = false;
    if (!template) {
      if (connected) {
        setTest({ phase: "idle" });
        haptics.success();
        toast.show({ title: t("lite:settings.setup.test.checkOk"), kind: "success" });
      } else {
        setTest({ phase: "awaitingPurchase" });
      }
      return;
    }
    setTest({ phase: "running", baseline: lastUsedAt, until: Date.now() + RUN_TIMEOUT_MS });
    try {
      await Linking.openURL(shortcutRunUrl());
    } catch (err) {
      setTest({ phase: "idle" });
      toast.show({ title: errorText(t, err), kind: "error" });
    }
  };

  const steps: { key: string; done: boolean; toggle?: () => void; node: ReactNode }[] = [];
  steps.push({
    key: "copy",
    done: progress.copied || connected,
    node: (
      <StepBody
        title={t("lite:settings.setup.copy.title")}
        body={t(
          template ? "lite:settings.setup.copy.bodyTemplate" : "lite:settings.setup.copy.bodyManual"
        )}
      >
        {template ? (
          <Button size="sm" variant="outline" onPress={() => void copy("both")}>
            {t("lite:settings.setup.copy.button")}
          </Button>
        ) : (
          <Box row gap={2}>
            <Button size="sm" variant="outline" onPress={() => void copy("url")}>
              {t("lite:settings.setup.copy.copyUrl")}
            </Button>
            <Button size="sm" variant="outline" onPress={() => void copy("header")}>
              {t("lite:settings.setup.copy.copyHeader")}
            </Button>
          </Box>
        )}
      </StepBody>
    ),
  });
  if (template) {
    steps.push({
      key: "add",
      done: progress.added || connected,
      toggle: () => update({ added: !progress.added }),
      node: (
        <StepBody
          title={t("lite:settings.setup.add.title")}
          body={t("lite:settings.setup.add.body")}
        >
          <Button size="sm" variant="outline" onPress={() => void open(template, { added: true })}>
            {t("lite:settings.setup.add.button")}
          </Button>
        </StepBody>
      ),
    });
    steps.push({
      key: "automate",
      done: progress.automated || connected,
      toggle: () => update({ automated: !progress.automated }),
      node: (
        <StepBody
          title={t("lite:settings.setup.automate.title")}
          body={t("lite:settings.setup.automate.body")}
        >
          <Button
            size="sm"
            variant="outline"
            onPress={() => void open("shortcuts://", { automated: true })}
          >
            {t("lite:settings.setup.automate.button")}
          </Button>
        </StepBody>
      ),
    });
  } else {
    steps.push({
      key: "build",
      done: progress.automated || connected,
      toggle: () => update({ automated: !progress.automated }),
      node: (
        <StepBody
          title={t("lite:settings.setup.build.title")}
          body={t("lite:settings.setup.build.body")}
        >
          {showBuild || !(progress.automated || connected) ? (
            <Box gap={2}>
              {BUILD_STEPS.map((n) => (
                <Text key={n} variant="caption" style={{ color: colors.foreground }}>
                  {t("lite:settings.setup.build.step", {
                    n,
                    text: t(`lite:settings.setup.build.steps.${n}`),
                  })}
                </Text>
              ))}
            </Box>
          ) : null}
          <Box row gap={2}>
            <Button
              size="sm"
              variant="outline"
              onPress={() => void open("shortcuts://", { automated: true })}
            >
              {t("lite:settings.setup.build.button")}
            </Button>
            {progress.automated || connected ? (
              <Button size="sm" variant="ghost" onPress={() => setShowBuild((v) => !v)}>
                {t(showBuild ? "lite:settings.setup.build.hide" : "lite:settings.setup.build.show")}
              </Button>
            ) : null}
          </Box>
        </StepBody>
      ),
    });
  }
  steps.push({
    key: "test",
    done: connected,
    node: (
      <StepBody
        title={t("lite:settings.setup.test.title")}
        body={t(
          template ? "lite:settings.setup.test.bodyTemplate" : "lite:settings.setup.test.bodyManual"
        )}
      >
        <Button
          size="sm"
          variant={connected ? "outline" : "primary"}
          loading={test.phase === "checking"}
          onPress={() => void runTest()}
        >
          {t(template ? "lite:settings.setup.test.run" : "lite:settings.setup.test.check")}
        </Button>
        <TestMessage test={test} host={server ? serverHost(server) : ""} />
      </StepBody>
    ),
  });

  const doneCount = steps.filter((s) => s.done).length;

  return (
    <RowGroup title={t("lite:settings.shortcutTitle")}>
      <Box p={4} row gap={3} align="center" testID="shortcut-status">
        {connected ? (
          <Icon name="checkmark.seal.fill" fallback="verified" size={32} color="success" />
        ) : waiting ? (
          <Spinner />
        ) : (
          <Icon
            name="wave.3.right.circle.fill"
            fallback="contactless"
            size={32}
            color="brandAccent"
          />
        )}
        <Box style={{ flex: 1 }} gap={1}>
          <Text weight="semibold">
            {connected
              ? t("lite:settings.setup.statusOk")
              : test.phase === "running"
                ? t("lite:settings.setup.waiting")
                : test.phase === "awaitingPurchase"
                  ? t("lite:settings.setup.waitingPay")
                  : t("lite:settings.setup.statusTodo")}
          </Text>
          <Text variant="caption">
            {connected
              ? lastCaptureAt
                ? t("lite:settings.setup.statusOkPurchase", { time: f.dateTime(lastCaptureAt) })
                : t("lite:settings.setup.statusOkHeard", { time: f.dateTime(lastUsedAt!) })
              : waiting
                ? t("lite:settings.shortcutIntro")
                : t("lite:settings.setup.statusProgress", { done: doneCount, total: steps.length })}
          </Text>
        </Box>
      </Box>
      {steps.map((s, i) => (
        <Box key={s.key} px={4} pb={4} row gap={3} testID={`shortcut-step-${s.key}`}>
          <StepMark n={i + 1} done={s.done} onPress={connected ? undefined : s.toggle} />
          <Box style={{ flex: 1 }} gap={2}>
            {s.node}
          </Box>
        </Box>
      ))}
    </RowGroup>
  );
}

function StepBody({ title, body, children }: { title: string; body: string; children: ReactNode }) {
  return (
    <>
      <Text weight="semibold">{title}</Text>
      <Text variant="caption">{body}</Text>
      <Box gap={2} align="flex-start">
        {children}
      </Box>
    </>
  );
}

/** The step number, or a check once done. Tapping it marks a step the app cannot see as done or not done. */
function StepMark({ n, done, onPress }: { n: number; done: boolean; onPress?: () => void }) {
  const t = useKassaT();
  const { colors } = useTheme();
  const mark = (
    <Box
      align="center"
      justify="center"
      style={{
        width: 24,
        height: 24,
        borderRadius: 12,
        backgroundColor: done ? colors.success : colors.muted,
      }}
    >
      {done ? (
        <Icon name="checkmark" fallback="check" size={13} color="background" />
      ) : (
        <Text variant="caption" weight="semibold">
          {n}
        </Text>
      )}
    </Box>
  );
  if (!onPress) return mark;
  return (
    <Pressable
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      hitSlop={10}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done }}
      accessibilityLabel={t(
        done ? "lite:settings.setup.markUndone" : "lite:settings.setup.markDone"
      )}
    >
      {mark}
    </Pressable>
  );
}

function TestMessage({ test, host }: { test: Test; host: string }) {
  const t = useKassaT();
  const { colors } = useTheme();
  if (test.phase === "awaitingPurchase") {
    return (
      <Text variant="caption" style={{ color: colors.success }}>
        {t("lite:settings.setup.test.serverOk")}
      </Text>
    );
  }
  if (test.phase === "timeout" || test.phase === "error") {
    const text =
      test.phase === "timeout"
        ? t("lite:settings.setup.test.timeout")
        : t(`lite:settings.setup.test.${test.result}`, { host });
    return (
      <Text variant="caption" style={{ color: colors.destructive }}>
        {text}
      </Text>
    );
  }
  return null;
}
