/**
 * The chat's mic button, the parts without UI: what to tell the person when voice input fails, and the timer label.
 * Recording lives in lib/voice (expo-audio on native, MediaRecorder → WAV on web), speech to text on the server
 * (POST /agent/transcribe).
 */
import { KassaApiError } from "@/api/errors";
import { errorText } from "@/components/kassa/error-text";
import type { TFn } from "@/lib/i18n";
import { VoiceInputError } from "@/lib/voice/types";

/** Nothing intelligible was said (the server answered an empty transcript). */
export class NothingHeardError extends Error {
  constructor() {
    super("nothing heard");
    this.name = "NothingHeardError";
  }
}

/** One readable line per way voice input can fail. */
export function voiceErrorText(t: TFn, err: unknown): string {
  if (err instanceof NothingHeardError) return t("chat:voice.errors.nothingHeard");
  if (err instanceof VoiceInputError) {
    if (err.kind === "denied") return t("chat:voice.errors.denied");
    if (err.kind === "unavailable") return t("chat:voice.errors.unavailable");
    return t("chat:voice.errors.failed");
  }
  if (err instanceof KassaApiError) {
    switch (err.code) {
      case "AI_PROVIDER_KEY_MISSING":
      case "AI_PROVIDER_UNKNOWN":
      case "AI_MODEL_SPEC_INVALID":
        return t("chat:voice.errors.notSetUp");
      case "AI_CONSENT_REQUIRED":
      case "PIPL_CONSENT_REQUIRED":
        return t("chat:voice.errors.consent");
      case "VOICE_UNREADABLE":
        return t("chat:voice.errors.unreadable");
      case "VOICE_TOO_LARGE":
        return t("chat:voice.errors.tooLong");
      case "VOICE_UNAVAILABLE":
        return t("chat:voice.errors.model");
      case "RATE_LIMITED":
        return t("chat:voice.errors.rateLimited");
    }
  }
  return errorText(t, err);
}

/** 0:07, 1:00 */
export function recordingClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
