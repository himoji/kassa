/**
 * Web recorder (the web app in a browser, also inside KassaLite's in-app browser): getUserMedia + MediaRecorder,
 * then the recording is decoded with Web Audio and re-encoded as 16 kHz mono WAV (wav.ts explains why). An
 * AnalyserNode on the same stream drives the level meter.
 */
import { encodeWav, bytesToBase64, levelOf, mixToMono, resample, WAV_SAMPLE_RATE } from "./wav";
import { type ActiveRecording, VoiceInputError } from "./types";

export { MAX_RECORDING_MS, VoiceInputError } from "./types";
export type { ActiveRecording, Recording, RecordingFormat, VoiceInputErrorKind } from "./types";

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext
  );
}

/** getUserMedia needs a secure context (https or localhost); MediaRecorder is in every current browser. */
export function voiceInputAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined" &&
    audioContextCtor() !== undefined
  );
}

async function toWavBase64(blob: Blob, Ctor: AudioContextCtor): Promise<string> {
  const ctx = new Ctor();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const channels: Float32Array[] = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
    const mono = resample(mixToMono(channels), decoded.sampleRate, WAV_SAMPLE_RATE);
    return bytesToBase64(encodeWav(mono, WAV_SAMPLE_RATE));
  } finally {
    void ctx.close().catch(() => {});
  }
}

export async function startRecording(): Promise<ActiveRecording> {
  const Ctor = audioContextCtor();
  if (!voiceInputAvailable() || !Ctor) throw new VoiceInputError("unavailable");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "NotAllowedError" || name === "SecurityError") throw new VoiceInputError("denied");
    if (name === "NotFoundError" || name === "OverconstrainedError")
      throw new VoiceInputError("unavailable");
    throw new VoiceInputError("failed", String(err));
  }
  const releaseMic = () => stream.getTracks().forEach((track) => track.stop());

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream);
  } catch (err) {
    releaseMic();
    throw new VoiceInputError("failed", String(err));
  }
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  // Level meter: a separate context reading the live stream (never connected to the speakers).
  let meterCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  try {
    meterCtx = new Ctor();
    analyser = meterCtx.createAnalyser();
    analyser.fftSize = 512;
    meterCtx.createMediaStreamSource(stream).connect(analyser);
  } catch {
    analyser = null;
  }
  const frame = new Float32Array(analyser?.fftSize ?? 0);

  recorder.start(250);
  const startedAt = Date.now();
  let done = false;

  const finish = async () => {
    if (done) return;
    done = true;
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    releaseMic();
    void meterCtx?.close().catch(() => {});
  };

  return {
    level() {
      if (done || !analyser) return 0;
      analyser.getFloatTimeDomainData(frame);
      return levelOf(frame);
    },
    async stop() {
      const durationMs = Date.now() - startedAt;
      await finish();
      const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || "" });
      if (blob.size === 0) throw new VoiceInputError("failed", "empty recording");
      try {
        return { base64: await toWavBase64(blob, Ctor), format: "wav" as const, durationMs };
      } catch (err) {
        throw new VoiceInputError("failed", `could not decode ${blob.type}: ${String(err)}`);
      }
    },
    async cancel() {
      await finish();
    },
  };
}
