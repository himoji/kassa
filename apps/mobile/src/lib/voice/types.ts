/** The chat's voice input (mic button): one recording, sent to POST /agent/transcribe. */

/** Formats the recorder produces; both are in the server's VOICE_FORMATS. */
export type RecordingFormat = "m4a" | "wav";

export interface Recording {
  base64: string;
  format: RecordingFormat;
  durationMs: number;
}

export interface ActiveRecording {
  /** Current input level, 0..1 (for the meter). */
  level(): number;
  /** Finish and return the audio. */
  stop(): Promise<Recording>;
  /** Throw the recording away. */
  cancel(): Promise<void>;
}

/** A recording stops by itself after this long (a minute of 16 kHz WAV is about 1.9 MB, under the server's 3 MB). */
export const MAX_RECORDING_MS = 60_000;

export type VoiceInputErrorKind = "denied" | "unavailable" | "failed";

export class VoiceInputError extends Error {
  constructor(
    readonly kind: VoiceInputErrorKind,
    message: string = kind
  ) {
    super(message);
    this.name = "VoiceInputError";
  }
}
