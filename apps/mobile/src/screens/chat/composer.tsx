/**
 * The chat composer: text field, send / stop, and the mic. Mic flow: tap the mic → recording (timer, live level,
 * cancel) → tap the arrow → transcribing → the transcript lands in the field and is sent after a short pause, unless
 * the person taps the field or "Edit" to change it first. The mic only shows when this build can record
 * (lib/voice: expo-audio in the binary, or a browser with getUserMedia).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { transcribeRecording } from "@/api/hooks/voice";
import { Icon, Spinner, Text, toast, useTheme } from "@/components/ui";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import {
  type ActiveRecording,
  MAX_RECORDING_MS,
  startRecording,
  voiceInputAvailable,
} from "@/lib/voice/recorder";

import { NothingHeardError, recordingClock, voiceErrorText } from "./voice";

/** How long the transcript stays in the field before it is sent by itself. */
export const AUTO_SEND_MS = 1800;
const BARS = 5;

type Phase = "idle" | "starting" | "recording" | "transcribing";

export function ChatComposer({
  value,
  onChangeText,
  onSend,
  onStop,
  busy,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
}) {
  const t = useKassaT();
  const { colors } = useTheme();
  const [canRecord] = useState(voiceInputAvailable);
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  const [autoSend, setAutoSend] = useState(false);
  const recording = useRef<ActiveRecording | null>(null);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<TextInput>(null);
  const mounted = useRef(true);

  const fail = useCallback(
    (err: unknown) => {
      haptics.error();
      toast.show({
        kind: "error",
        title: t("chat:voice.errors.title"),
        description: voiceErrorText(t, err),
      });
    },
    [t]
  );

  const stopAndTranscribe = useCallback(async () => {
    const rec = recording.current;
    if (!rec) return;
    recording.current = null;
    setPhase("transcribing");
    haptics.selection();
    const controller = new AbortController();
    abort.current = controller;
    try {
      const audio = await rec.stop();
      if (controller.signal.aborted) return;
      const text = await transcribeRecording(audio, controller.signal);
      if (controller.signal.aborted || !mounted.current) return;
      if (!text) throw new NothingHeardError();
      onChangeText(text);
      setAutoSend(true);
      haptics.success();
    } catch (err) {
      if (!controller.signal.aborted && mounted.current) fail(err);
    } finally {
      if (abort.current === controller) abort.current = null;
      if (mounted.current) setPhase("idle");
    }
  }, [fail, onChangeText]);

  const start = async () => {
    if (phase !== "idle" || busy) return;
    setAutoSend(false);
    setPhase("starting");
    haptics.impact();
    try {
      const rec = await startRecording();
      if (!mounted.current) {
        void rec.cancel();
        return;
      }
      recording.current = rec;
      setElapsed(0);
      setLevels(Array(BARS).fill(0));
      setPhase("recording");
    } catch (err) {
      setPhase("idle");
      fail(err);
    }
  };

  const cancel = () => {
    haptics.selection();
    const rec = recording.current;
    recording.current = null;
    abort.current?.abort();
    abort.current = null;
    void rec?.cancel();
    setPhase("idle");
  };

  // Timer and level meter while recording; stops by itself at MAX_RECORDING_MS.
  useEffect(() => {
    if (phase !== "recording") return;
    const startedAt = Date.now();
    const id = setInterval(() => {
      const ms = Date.now() - startedAt;
      setElapsed(ms);
      const level = recording.current?.level() ?? 0;
      setLevels((prev) => [...prev.slice(1), level]);
      if (ms >= MAX_RECORDING_MS) void stopAndTranscribe();
    }, 100);
    return () => clearInterval(id);
  }, [phase, stopAndTranscribe]);

  // The transcript is sent after a short look, unless the person started editing it. Refs: a parent re-render
  // (new `onSend`) must not restart the pause.
  const latest = useRef({ onSend, value });
  useEffect(() => {
    latest.current = { onSend, value };
  });
  useEffect(() => {
    if (!autoSend) return;
    const id = setTimeout(() => {
      setAutoSend(false);
      latest.current.onSend(latest.current.value);
    }, AUTO_SEND_MS);
    return () => clearTimeout(id);
  }, [autoSend]);

  // Leaving the chat drops a recording in progress (mic released, file deleted).
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
      void recording.current?.cancel();
      recording.current = null;
    };
  }, []);

  const editTranscript = () => {
    setAutoSend(false);
    input.current?.focus();
  };

  const voiceActive = phase === "recording" || phase === "transcribing";
  const showMic = canRecord && !busy && !voiceActive && value.trim() === "";

  const round = {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };

  return (
    <View
      style={{
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 6,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.background,
      }}
    >
      {autoSend ? (
        <View
          style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 }}
          testID="voice-autosend"
        >
          <Text variant="caption" style={{ flex: 1 }}>
            {t("chat:voice.sendingSoon")}
          </Text>
          <Pressable onPress={editTranscript} accessibilityRole="button" hitSlop={8}>
            <Text variant="caption" style={{ color: colors.brandAccent }}>
              {t("chat:voice.edit")}
            </Text>
          </Pressable>
        </View>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
        {voiceActive ? (
          <View
            style={{
              flex: 1,
              minHeight: 44,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              paddingHorizontal: 6,
              borderRadius: 22,
              backgroundColor: colors.muted,
            }}
            testID={phase === "recording" ? "voice-recording" : "voice-transcribing"}
            accessibilityLiveRegion="polite"
          >
            <Pressable
              onPress={cancel}
              accessibilityRole="button"
              accessibilityLabel={t("chat:voice.cancel")}
              hitSlop={6}
              style={{ ...round, width: 32, height: 32 }}
              testID="voice-cancel"
            >
              <Icon name="xmark" fallback="close" size={16} color="mutedForeground" />
            </Pressable>
            {phase === "recording" ? (
              <>
                <View
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    backgroundColor: colors.destructive,
                    opacity: 0.5 + 0.5 * Math.min(1, (levels.at(-1) ?? 0) * 1.5),
                    transform: [{ scale: 1 + Math.min(1, levels.at(-1) ?? 0) * 0.6 }],
                  }}
                />
                <Text style={{ fontVariant: ["tabular-nums"] }}>{recordingClock(elapsed)}</Text>
                <View
                  style={{
                    flex: 1,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 3,
                    height: 24,
                  }}
                  accessibilityLabel={t("chat:voice.recordingA11y")}
                >
                  {levels.map((l, i) => (
                    <View
                      key={i}
                      style={{
                        width: 4,
                        height: 4 + Math.round(Math.min(1, l) * 20),
                        borderRadius: 2,
                        backgroundColor: colors.brandAccent,
                      }}
                    />
                  ))}
                  <Text variant="caption" style={{ marginStart: 6 }} numberOfLines={1}>
                    {t("chat:voice.listening")}
                  </Text>
                </View>
              </>
            ) : (
              <>
                <Spinner size="sm" />
                <Text variant="caption">{t("chat:voice.transcribing")}</Text>
              </>
            )}
          </View>
        ) : (
          <TextInput
            ref={input}
            value={value}
            onChangeText={(text) => {
              setAutoSend(false);
              onChangeText(text);
            }}
            onFocus={() => setAutoSend(false)}
            placeholder={t("chat:placeholder")}
            placeholderTextColor={colors.mutedForeground}
            accessibilityLabel={t("chat:inputA11y")}
            multiline
            maxLength={4000}
            onSubmitEditing={() => onSend(value)}
            // Web: Enter sends, Shift+Enter adds a line (a multiline input never submits on its own there).
            onKeyPress={
              process.env.EXPO_OS === "web"
                ? (e) => {
                    const key = e.nativeEvent as unknown as {
                      key: string;
                      shiftKey?: boolean;
                      isComposing?: boolean;
                    };
                    if (key.key !== "Enter" || key.shiftKey || key.isComposing) return;
                    e.preventDefault();
                    onSend(value);
                  }
                : undefined
            }
            style={{
              flex: 1,
              minHeight: 44,
              maxHeight: 140,
              paddingHorizontal: 14,
              paddingVertical: 10,
              borderRadius: 22,
              backgroundColor: colors.muted,
              color: colors.foreground,
              fontSize: 16,
            }}
          />
        )}
        {phase === "recording" ? (
          <Pressable
            onPress={() => void stopAndTranscribe()}
            accessibilityRole="button"
            accessibilityLabel={t("chat:voice.done")}
            style={{ ...round, backgroundColor: colors.brandAccent }}
            testID="voice-done"
          >
            <Icon name="arrow.up" fallback="arrow_upward" size={20} color="primaryForeground" />
          </Pressable>
        ) : showMic || phase === "starting" ? (
          <Pressable
            onPress={() => void start()}
            disabled={phase === "starting"}
            accessibilityRole="button"
            accessibilityLabel={t("chat:voice.start")}
            style={{
              ...round,
              backgroundColor: colors.brandAccent,
              opacity: phase === "starting" ? 0.6 : 1,
            }}
            testID="voice-start"
          >
            <Icon name="mic.fill" fallback="mic" size={20} color="primaryForeground" />
          </Pressable>
        ) : (
          <Pressable
            onPress={() => {
              setAutoSend(false);
              if (busy) onStop();
              else onSend(value);
            }}
            disabled={phase === "transcribing"}
            accessibilityRole="button"
            accessibilityLabel={busy ? t("chat:stop") : t("chat:send")}
            style={{
              ...round,
              backgroundColor: colors.brandAccent,
              opacity: phase === "transcribing" ? 0.6 : 1,
            }}
          >
            <Icon
              name={busy ? "stop.fill" : "arrow.up"}
              fallback={busy ? "stop" : "arrow_upward"}
              size={20}
              color="primaryForeground"
            />
          </Pressable>
        )}
      </View>
    </View>
  );
}
