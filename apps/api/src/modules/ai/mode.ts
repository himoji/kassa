import { eq } from "drizzle-orm";

import type { AgentMode } from "@kassa/shared";

import { getDb } from "../../db/client.ts";
import { demoState } from "../../db/schema.ts";

/*
 * LIVE vs REPLAY (spec §9 "Replay mode"). REPLAY if AGENT_MODE=REPLAY or demo_state.agentMode=REPLAY
 * (demo panel toggle). RECORD=1 (live only) records model outputs into fixtures/agent-recordings/.
 */
export async function currentAgentMode(): Promise<AgentMode> {
  if (process.env.AGENT_MODE === "REPLAY") return "REPLAY";
  try {
    const row = (await getDb().select({ agentMode: demoState.agentMode }).from(demoState).where(eq(demoState.id, 1)))[0];
    return row?.agentMode ?? "LIVE";
  } catch {
    return "LIVE";
  }
}

export function recordingEnabled(): boolean {
  return process.env.RECORD === "1";
}
