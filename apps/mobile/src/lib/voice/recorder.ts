/**
 * Native recorder (iOS / Android) through expo-audio: AAC in an .m4a file, mono, metering on for the level meter.
 *
 * expo-audio is a native module. A KassaLite (or full app) binary built before it was added receives this JS over
 * the air, so the module is looked up with `requireOptionalNativeModule` and loaded lazily: without it
 * `voiceInputAvailable()` is false and the chat hides the mic instead of crashing. The web build uses
 * recorder.web.ts.
 */
import { requireOptionalNativeModule } from "expo";
import { File } from "expo-file-system";
import { Platform } from "react-native";

import { levelFromDb } from "./wav";
import { type ActiveRecording, VoiceInputError } from "./types";

export { MAX_RECORDING_MS, VoiceInputError } from "./types";
export type { ActiveRecording, Recording, RecordingFormat, VoiceInputErrorKind } from "./types";

/** True when this binary carries expo-audio's native module. */
export function voiceInputAvailable(): boolean {
  return (
    (Platform.OS === "ios" || Platform.OS === "android") &&
    requireOptionalNativeModule("ExpoAudio") !== null
  );
}

type ExpoAudio = typeof import("expo-audio");

function loadAudio(): ExpoAudio {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded lazily: absent in older binaries
  return require("expo-audio") as ExpoAudio;
}

/** expo-audio's per-platform options, flattened the way its own `useAudioRecorder` does. */
function recorderOptions(audio: ExpoAudio): Record<string, unknown> {
  const common = {
    extension: ".m4a",
    sampleRate: 22_050,
    numberOfChannels: 1,
    bitRate: 48_000,
    isMeteringEnabled: true,
  };
  return Platform.OS === "ios"
    ? {
        ...common,
        outputFormat: audio.IOSOutputFormat.MPEG4AAC,
        audioQuality: audio.AudioQuality.MEDIUM,
        linearPCMBitDepth: 16,
        linearPCMIsBigEndian: false,
        linearPCMIsFloat: false,
      }
    : { ...common, outputFormat: "mpeg4", audioEncoder: "aac" };
}

async function endSession(audio: ExpoAudio): Promise<void> {
  // Give the audio session back (playback, other apps); never let this hide the real outcome.
  await audio.setAudioModeAsync({ allowsRecording: false }).catch(() => {});
}

function deleteFile(uri: string | null): void {
  if (!uri) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    /* the cache directory is cleared by the OS anyway */
  }
}

/** Ask for the microphone (first time) and start recording. Throws VoiceInputError. */
export async function startRecording(): Promise<ActiveRecording> {
  if (!voiceInputAvailable()) throw new VoiceInputError("unavailable");
  const audio = loadAudio();
  const permission = await audio.requestRecordingPermissionsAsync();
  if (!permission.granted) throw new VoiceInputError("denied");

  let recorder: InstanceType<ExpoAudio["AudioModule"]["AudioRecorder"]>;
  try {
    await audio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    recorder = new audio.AudioModule.AudioRecorder(
      recorderOptions(audio) as ConstructorParameters<ExpoAudio["AudioModule"]["AudioRecorder"]>[0]
    );
    await recorder.prepareToRecordAsync();
    recorder.record();
  } catch (err) {
    await endSession(audio);
    throw new VoiceInputError("failed", err instanceof Error ? err.message : String(err));
  }
  const startedAt = Date.now();
  let done = false;

  const finish = async (): Promise<string | null> => {
    if (done) return null;
    done = true;
    try {
      await recorder.stop();
      return recorder.uri;
    } finally {
      await endSession(audio);
    }
  };

  return {
    level() {
      if (done) return 0;
      try {
        return levelFromDb(recorder.getStatus().metering);
      } catch {
        return 0;
      }
    },
    async stop() {
      const durationMs = Date.now() - startedAt;
      let uri: string | null = null;
      try {
        uri = await finish();
        if (!uri) throw new VoiceInputError("failed", "no recording");
        const base64 = await new File(uri).base64();
        return { base64, format: "m4a" as const, durationMs };
      } catch (err) {
        throw err instanceof VoiceInputError
          ? err
          : new VoiceInputError("failed", err instanceof Error ? err.message : String(err));
      } finally {
        deleteFile(uri);
        recorder.release();
      }
    },
    async cancel() {
      try {
        deleteFile(await finish());
      } catch {
        /* nothing to keep */
      } finally {
        recorder.release();
      }
    },
  };
}
