import { describe, expect, it } from "@jest/globals";

import { KassaApiError } from "@/api/errors";
import { VoiceInputError } from "@/lib/voice/types";

import { NothingHeardError, recordingClock, voiceErrorText } from "../voice";

const t = (key: string) => key;
const problem = (status: number, code: string) => new KassaApiError(status, { error: code, code });

describe("chat voice input", () => {
  it("explains every failure in plain words", () => {
    expect(voiceErrorText(t, new VoiceInputError("denied"))).toBe("chat:voice.errors.denied");
    expect(voiceErrorText(t, new VoiceInputError("unavailable"))).toBe(
      "chat:voice.errors.unavailable"
    );
    expect(voiceErrorText(t, new NothingHeardError())).toBe("chat:voice.errors.nothingHeard");
    expect(voiceErrorText(t, problem(503, "AI_PROVIDER_KEY_MISSING"))).toBe(
      "chat:voice.errors.notSetUp"
    );
    expect(voiceErrorText(t, problem(403, "AI_CONSENT_REQUIRED"))).toBe(
      "chat:voice.errors.consent"
    );
    expect(voiceErrorText(t, problem(422, "VOICE_UNREADABLE"))).toBe(
      "chat:voice.errors.unreadable"
    );
    expect(voiceErrorText(t, problem(429, "RATE_LIMITED"))).toBe("chat:voice.errors.rateLimited");
  });

  it("shows the recording time as m:ss", () => {
    expect(recordingClock(0)).toBe("0:00");
    expect(recordingClock(7_400)).toBe("0:07");
    expect(recordingClock(60_000)).toBe("1:00");
  });
});
