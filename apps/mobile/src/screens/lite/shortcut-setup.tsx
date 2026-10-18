import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Linking } from "react-native";

import { useShortcutDevices } from "@/api/hooks/shortcut";
import { errorText } from "@/components/kassa/error-text";
import { RowGroup } from "@/components/row-group";
import { Box, Button, Icon, Spinner, Text, toast, useTheme } from "@/components/ui";
import { copyToClipboard } from "@/lib/clipboard";
import { useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { hasLogPaymentAction, syncIntentConfig } from "@/lite/intent-config";
import { loadServerUrl } from "@/lite/server-url";
import {
  aiSetupPrompt,
  checkShortcutConnection,
  loadSetupStarted,
  readyShortcutLink,
  saveSetupStarted,
  shortcutUrlWithKey,
  tapCheckLines,
  tapCheckPassed,
  type CheckLine,
  type ConnectionCheck,
  type TapCheck,
} from "@/lite/shortcut-check";
import { loadShortcutToken } from "@/lite/shortcut-token";
import { fetchRecent, RECENT_KEY } from "@/lite/use-recent-captures";

const ACTION_STEPS = ["1", "2", "3"] as const;
const MANUAL_STEPS = ["1", "2", "3", "4", "5"] as const;
/** GET /devices while the card waits for a tap (or for a fixed one); the app is in the foreground. */
const POLL_MS = 5000;

/** "kassa-sand.vercel.app" for the stored `https://` origin. */
export function serverHost(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

type Mode = "start" | "waiting" | "report" | "legacy";
/**
 * How this iPhone gets its automation: "action", the build's "Log Payment in Kassa" action (nothing to paste);
 * "ready", the published ready-made Shortcut (its import question takes the copied link); "link", a hand-built
 * Shortcut with the copied link in Get Contents of URL.
 */
type Path = "action" | "ready" | "link";

/**
 * KassaLite Settings → "Apple Pay Shortcut": one button, then proof.
 *
 * "Set up" checks the server and key from this iPhone (`{test: true}`, nothing logged), readies the automation's
 * one input (builds with the "Log Payment in Kassa" action: its Keychain copy; other builds: the endpoint link with
 * the key, copied, only on this tap) and opens the ready-made Shortcut when one is published, Shortcuts otherwise.
 * One line then says what is left (paste when asked, and the Transaction automation, which iOS lets no app create);
 * the hand-built steps sit behind "Manual setup". The card waits for a real Apple Pay tap and reports, line by
 * line, what the automation sent and whether Kassa logged it (GET /devices `lastCheck`), with the fix for each
 * wrong line.
 */
export function ShortcutSetup() {
  const t = useKassaT();
  const f = useFormat();
  const [hasAction, setHasAction] = useState(false);
  const [started, setStarted] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Exclude<ConnectionCheck, "ok"> | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const readyLink = readyShortcutLink();
  const path: Path = hasAction ? "action" : readyLink ? "ready" : "link";

  useEffect(() => {
    void hasLogPaymentAction().then(setHasAction);
    void loadSetupStarted().then(setStarted);
    void loadServerUrl().then(setServer);
  }, []);

  const [pollMs, setPollMs] = useState<number | false>(false);
  const devices = useShortcutDevices(pollMs);
  const check = (devices.data?.lastCheck ?? null) as TapCheck | null;
  const real = check && check.kind !== "TEST" ? check : null;
  const passed = real ? tapCheckPassed(real) : false;
  const mode: Mode = real
    ? "report"
    : !check && devices.data?.lastCaptureAt
      ? "legacy"
      : started || check
        ? "waiting"
        : "start";
  const wantPoll = mode === "waiting" || (mode === "report" && !passed) ? POLL_MS : false;
  if (wantPoll !== pollMs) setPollMs(wantPoll);

  // The purchase the last tap logged, for its merchant and amount (the device keeps no such values).
  const recent = useQuery({
    queryKey: RECENT_KEY,
    queryFn: ({ signal }) => fetchRecent(signal),
    enabled: Boolean(real?.transactionId),
  });
  const tx = real?.transactionId
    ? recent.data?.captures.find((c) => c.id === real.transactionId)
    : undefined;

  // Say it out loud when a new tap is checked while the card is on screen (not for the one already there).
  const seen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!devices.data) return;
    const at = check?.at ?? null;
    if (seen.current === undefined) {
      seen.current = at;
      return;
    }
    if (at === seen.current) return;
    seen.current = at;
    if (!real) return;
    if (passed) {
      haptics.success();
      toast.show({ title: t("lite:settings.setup.success"), kind: "success" });
    } else {
      haptics.warning();
      toast.show({ title: t("lite:settings.setup.needsFix"), kind: "error" });
    }
  }, [devices.data, check?.at, real, passed, t]);

  const setUp = async () => {
    setError(null);
    const [token, stored] = await Promise.all([loadShortcutToken(), loadServerUrl()]);
    if (!token || !stored) {
      haptics.error();
      toast.show({ title: t("lite:settings.setup.noToken"), kind: "error" });
      return;
    }
    setBusy(true);
    const result = await checkShortcutConnection(stored, token);
    setBusy(false);
    if (result !== "ok") {
      haptics.error();
      setError(result);
      return;
    }
    if (path === "action") {
      await syncIntentConfig();
    } else {
      // The key goes on the clipboard only here, on this tap; never into a URL that is opened.
      const copied = await copyToClipboard(shortcutUrlWithKey(stored, token), {
        toast: t(
          path === "ready"
            ? "lite:settings.setup.copiedLinkReady"
            : "lite:settings.setup.copiedLink"
        ),
      });
      if (!copied) {
        haptics.error();
        toast.show({ title: t("lite:settings.setup.copyFailed"), kind: "error" });
        return;
      }
    }
    await saveSetupStarted();
    setStarted(true);
    // Fixing an automation opens Shortcuts itself: adding the ready-made Shortcut again would make a second copy.
    const target = path === "ready" && mode !== "report" && readyLink ? readyLink : "shortcuts://";
    try {
      await Linking.openURL(target);
    } catch (err) {
      toast.show({ title: errorText(t, err), kind: "error" });
    }
  };

  const copyAi = async () => {
    await copyToClipboard(aiSetupPrompt(hasAction), { toast: t("lite:settings.setup.copiedAi") });
    haptics.selection();
  };

  const fixes = real ? tapCheckLines(real).filter((l) => l.state === "fix").length : 0;
  const lastAt = real?.at ?? devices.data?.lastCaptureAt ?? null;

  const title =
    mode === "start"
      ? t("lite:settings.setup.start.title")
      : mode === "waiting"
        ? t("lite:settings.setup.waiting.title")
        : mode === "legacy" || passed
          ? t("lite:settings.setup.report.ok")
          : t("lite:settings.setup.report.fix", { count: fixes });
  const body =
    mode === "start"
      ? t("lite:settings.setup.start.body")
      : mode === "waiting"
        ? check?.kind === "TEST"
          ? t("lite:settings.setup.waiting.testOnly")
          : t(`lite:settings.setup.next.${path}`)
        : mode === "legacy"
          ? t("lite:settings.setup.report.legacy", { time: f.dateTime(lastAt!) })
          : passed
            ? t("lite:settings.setup.report.okBody", { time: f.dateTime(lastAt!) })
            : t("lite:settings.setup.report.fixBody");
  const primary =
    mode === "start"
      ? t("lite:settings.setup.start.button")
      : mode === "waiting"
        ? path === "action"
          ? t("lite:settings.setup.openShortcuts")
          : path === "ready"
            ? t("lite:settings.setup.copyLinkAdd")
            : t("lite:settings.setup.copyLinkOpen")
        : mode === "report" && !passed
          ? t("lite:settings.setup.fixButton")
          : null;
  const steps = hasAction ? ACTION_STEPS : MANUAL_STEPS;
  const stepsKey = hasAction ? "stepsAction" : "stepsManual";

  return (
    <RowGroup title={t("lite:settings.shortcutTitle")}>
      <Box p={4} gap={4}>
        <Box row gap={3} align="center" testID="shortcut-status">
          {mode === "waiting" ? (
            <Spinner />
          ) : mode === "start" ? (
            <Icon
              name="wave.3.right.circle.fill"
              fallback="contactless"
              size={32}
              color="brandAccent"
            />
          ) : mode === "legacy" || passed ? (
            <Icon name="checkmark.seal.fill" fallback="verified" size={32} color="success" />
          ) : (
            <Icon
              name="exclamationmark.triangle.fill"
              fallback="warning"
              size={30}
              color="destructive"
            />
          )}
          <Box style={{ flex: 1 }} gap={1}>
            <Text weight="semibold">{title}</Text>
            <Text variant="caption">{body}</Text>
          </Box>
        </Box>

        {real ? (
          <Box gap={2} testID="tap-check">
            {tapCheckLines(real).map((line) => (
              <CheckRow key={line.key} line={line}>
                {lineText(line, real, tx, t, f)}
              </CheckRow>
            ))}
          </Box>
        ) : null}

        {primary ? (
          <Button loading={busy} onPress={() => void setUp()}>
            {primary}
          </Button>
        ) : null}
        {error ? (
          <ErrorText>
            {t(`lite:settings.setup.${error}`, { host: server ? serverHost(server) : "" })}
          </ErrorText>
        ) : null}

        <Box gap={3}>
          <Box row>
            <Button size="sm" variant="ghost" onPress={() => setShowSteps((v) => !v)}>
              {t(showSteps ? "lite:settings.setup.hideSteps" : "lite:settings.setup.showSteps")}
            </Button>
          </Box>
          {showSteps ? (
            <Box gap={3}>
              <Box gap={2} testID="setup-steps">
                {steps.map((n) => (
                  <Text key={n} variant="caption">
                    {t("lite:settings.setup.step", {
                      n,
                      text: t(`lite:settings.setup.${stepsKey}.${n}`),
                    })}
                  </Text>
                ))}
                <Text variant="caption">{t("lite:settings.setup.aiHint")}</Text>
              </Box>
              <Box row>
                <Button size="sm" variant="outline" onPress={() => void copyAi()}>
                  {t("lite:settings.setup.copyAi")}
                </Button>
              </Box>
            </Box>
          ) : null}
        </Box>
      </Box>
    </RowGroup>
  );
}

type Tx = { merchant: string; amountMinor: number; currency: string } | undefined;

function lineText(
  line: CheckLine,
  check: TapCheck,
  tx: Tx,
  t: ReturnType<typeof useKassaT>,
  f: ReturnType<typeof useFormat>
): string {
  const k = (key: string, opts?: Record<string, string | number>) =>
    t(`lite:settings.setup.lines.${key}`, opts);
  switch (line.key) {
    case "reached":
      return k("reached", { time: f.dateTime(check.at) });
    case "merchant":
      if (line.state !== "ok") return k("merchantFix");
      return tx ? k("merchantOk", { name: tx.merchant }) : k("merchantOkPlain");
    case "amount":
      if (!check.fields.amount) return k("amountMissing");
      if (line.state !== "ok") return k("amountUnparsed");
      return tx
        ? k("amountOk", { amount: f.money(tx.amountMinor, tx.currency) })
        : k("amountOkPlain");
    case "card":
      return k(line.state === "ok" ? "cardOk" : "cardTip");
    case "place":
      return k(line.state === "ok" ? "placeOk" : "placeTip");
    case "logged":
      if (check.status === "MERGED") return k("loggedMerged");
      if (check.status === "IGNORED_INCOMING") return k("loggedRefund");
      return k(line.state === "ok" ? "loggedOk" : "loggedFix");
  }
}

function CheckRow({ line, children }: { line: CheckLine; children: string }) {
  const { colors } = useTheme();
  return (
    <Box row gap={2} align="flex-start" testID={`check-${line.key}-${line.state}`}>
      {line.state === "ok" ? (
        <Icon name="checkmark.circle.fill" fallback="check_circle" size={18} color="success" />
      ) : line.state === "fix" ? (
        <Icon name="xmark.circle.fill" fallback="cancel" size={18} color="destructive" />
      ) : (
        <Icon name="info.circle" fallback="info" size={18} color="mutedForeground" />
      )}
      <Text
        variant="caption"
        style={{
          flex: 1,
          color: line.state === "fix" ? colors.destructive : colors.foreground,
        }}
      >
        {children}
      </Text>
    </Box>
  );
}

function ErrorText({ children }: { children: string }) {
  const { colors } = useTheme();
  return (
    <Text variant="caption" style={{ color: colors.destructive }}>
      {children}
    </Text>
  );
}
