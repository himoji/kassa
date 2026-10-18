/**
 * Speech to text for the voice Shortcut (POST /capture/voice): one chat completion with the recording as an
 * OpenRouter `input_audio` part (base64; OpenRouter takes no audio URLs). VOICE_MODEL picks the model, default
 * Xiaomi MiMo-V2.6-Pro (text, image, audio and video in). Only the transcript leaves this module: the agent turn that
 * follows runs on the planner as usual, with its redaction, so the voice model sees the audio and nothing else.
 */
import { AiConfigError } from "./errors.ts";
import { OPENROUTER_BASE_URL, openRouterKey, parseModelSpec, type Env } from "./registry.ts";

export const DEFAULT_VOICE_MODEL = "openrouter:xiaomi/mimo-v2.6-pro";

/** Formats OpenRouter names for `input_audio`; iOS Record Audio makes m4a, Encode Media can make aiff. */
export const VOICE_FORMATS = ["m4a", "aac", "mp3", "wav", "aiff", "ogg", "flac"] as const;
export type VoiceFormat = (typeof VOICE_FORMATS)[number];

/** A spoken request is short; this also keeps the body under the serverless request limit (about 4.5 MB). */
export const MAX_VOICE_BYTES = 3 * 1024 * 1024;

const PROMPT =
  "Transcribe this voice note exactly, in the language spoken. Answer with the transcript only: no quotes, no notes. " +
  "If nothing intelligible is said, answer with an empty string.";

export function voiceSpec(env: Env = process.env) {
  const v = env.VOICE_MODEL?.trim() || DEFAULT_VOICE_MODEL;
  return parseModelSpec(v.includes(":") ? v : `openrouter:${v}`, "VOICE_MODEL");
}

export async function transcribeAudio(base64: string, format: VoiceFormat, env: Env = process.env, fetchImpl: typeof fetch = fetch): Promise<string> {
  const spec = voiceSpec(env);
  if (spec.provider !== "openrouter") {
    throw new AiConfigError("AI_PROVIDER_UNKNOWN", `VOICE_MODEL "${spec.id}": audio input is only wired for OpenRouter`, { provider: spec.provider });
  }
  const key = openRouterKey(env);
  if (!key) throw new AiConfigError("AI_PROVIDER_KEY_MISSING", `Model "${spec.id}" needs OPENROUTER_API_KEY to be set.`, { provider: "openrouter", keyEnv: "OPENROUTER_API_KEY" });
  const res = await fetchImpl(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: spec.modelId,
      temperature: 0,
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "input_audio", input_audio: { data: base64, format } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[]; error?: { message?: string } } | null;
  if (!res.ok) throw new VoiceError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
  const content = body?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim().replace(/^["“]|["”]$/g, "") : "";
}

/** The voice model refused the request (format not supported, provider down, no credit). */
export class VoiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "VoiceError";
  }
}
