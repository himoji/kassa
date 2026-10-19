import { describe, expect, it } from "@jest/globals";

import {
  bytesToBase64,
  encodeWav,
  levelFromDb,
  levelOf,
  mixToMono,
  resample,
  WAV_SAMPLE_RATE,
} from "@/lib/voice/wav";

describe("web voice recording → WAV", () => {
  it("writes a 16-bit mono PCM RIFF header and clamped samples", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2]), WAV_SAMPLE_RATE);
    const v = new DataView(wav.buffer);
    const ascii = (o: number) => String.fromCharCode(...wav.slice(o, o + 4));
    expect(ascii(0)).toBe("RIFF");
    expect(ascii(8)).toBe("WAVE");
    expect(ascii(36)).toBe("data");
    expect(v.getUint32(4, true)).toBe(36 + 8);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true))).toEqual([
      0, 32767, -32768, 32767,
    ]);
  });

  it("resamples 48 kHz to 16 kHz and mixes channels", () => {
    expect(resample(new Float32Array(48_000), 48_000, 16_000)).toHaveLength(16_000);
    expect(resample(new Float32Array([1, 2]), 16_000, 16_000)).toEqual(new Float32Array([1, 2]));
    expect(mixToMono([new Float32Array([1, 0]), new Float32Array([0, 1])])).toEqual(
      new Float32Array([0.5, 0.5])
    );
  });

  it("base64 matches Buffer's for every padding length", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 10_000]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37) % 256);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });

  it("maps levels to 0..1", () => {
    expect(levelOf(new Float32Array(10))).toBe(0);
    expect(levelOf(new Float32Array(10).fill(1))).toBe(1);
    expect(levelFromDb(-160)).toBe(0);
    expect(levelFromDb(0)).toBe(1);
    expect(levelFromDb(-25)).toBeCloseTo(0.5);
    expect(levelFromDb(undefined)).toBe(0);
  });
});
