/**
 * POST /agent/transcribe (apps/api agent/routes.ts): a recording from the chat's mic button → its transcript. The
 * server only transcribes; the chat sends the text to /agent/message as a normal turn. The contract is API-local,
 * so the schema lives here.
 */
import { z } from "zod";

import type { Recording } from "@/lib/voice/types";

import { api } from "../client";

const TranscribeResponse = z.object({ text: z.string() });

export async function transcribeRecording(rec: Recording, signal?: AbortSignal): Promise<string> {
  const { text } = await api.request("/agent/transcribe", {
    method: "POST",
    json: { audioBase64: rec.base64, format: rec.format },
    schema: TranscribeResponse,
    signal,
  });
  return text.trim();
}
