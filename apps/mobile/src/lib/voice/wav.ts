/**
 * Browser recordings come out as webm/opus (Chrome) or mp4/aac (Safari); the voice model takes neither webm nor
 * every mp4 flavour (apps/api ai/voice.ts VOICE_FORMATS), so the web recorder decodes the recording and sends it as
 * 16 kHz mono 16-bit PCM WAV: one format every browser can produce. 60 s is about 1.9 MB, under MAX_VOICE_BYTES.
 */

/** Speech needs no more than 16 kHz; it keeps a minute of audio near 2 MB. */
export const WAV_SAMPLE_RATE = 16_000;

/** Average the channels into one. */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0]!;
  const out = new Float32Array(channels[0]!.length);
  for (const ch of channels)
    for (let i = 0; i < out.length; i++) out[i]! += (ch[i] ?? 0) / channels.length;
  return out;
}

/** Linear-interpolation resample (downsampling speech to 16 kHz; aliasing above 8 kHz does not matter here). */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const length = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const out = new Float32Array(length);
  const step = fromRate / toRate;
  for (let i = 0; i < length; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = pos - i0;
    out[i] = (samples[i0] ?? 0) * (1 - frac) + (samples[i1] ?? 0) * frac;
  }
  return out;
}

/** A RIFF/WAVE file: mono, 16-bit little-endian PCM at `sampleRate`. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with padding (no `btoa` on a 2 MB binary string). */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    chunk +=
      B64[a >> 2]! +
      B64[((a & 3) << 4) | ((b ?? 0) >> 4)]! +
      (b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!) +
      (c === undefined ? "=" : B64[c & 63]!);
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  parts.push(chunk);
  return parts.join("");
}

/** Root-mean-square of a time-domain frame, mapped to 0..1 for the level meter (speech sits near 0.3–0.8). */
export function levelOf(frame: ArrayLike<number>): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  return Math.min(1, Math.sqrt(sum / frame.length) * 4);
}

/** iOS / Android metering is dBFS (-160 … 0): -50 dB and below is silence, 0 dB full. */
export function levelFromDb(db: number | undefined): number {
  if (db === undefined || !Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db + 50) / 50));
}
