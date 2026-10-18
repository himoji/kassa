/**
 * KassaLite Settings → "Data shown": Real (default) or Simulated, kept on this iPhone.
 *
 * Real shows only purchases that really happened: Apple Pay taps sent by the Shortcut or the Log Payment action, and
 * text, voice and screenshot captures. Simulated also shows the demo world: purchases from the notification
 * simulator (source NOTIF_SIM) and the demo seed's purchases.
 *
 * GET /capture/recent carries no "demo" flag, so a seeded purchase is recognised by how the seed writes it:
 * `createdAt` is set to `occurredAt` (apps/api/src/modules/demo/seed.ts). A live capture takes `createdAt` from the
 * clock after its database lookups, so in practice it never equals `occurredAt` to the millisecond.
 */
import { SIMULATOR_SOURCE, type RecentCapture, type RecentCapturesResponse } from "@kassa/shared";
import { useEffect } from "react";

import { storage } from "@/lib/storage";
import { createPersistedStore } from "@/stores/create-store";

export type DataMode = "real" | "simulated";

export interface DataModeState {
  mode: DataMode;
}

export const DATA_MODE_KEY = "kassalite:dataMode.v1";

export const dataModeStore = createPersistedStore<DataModeState>({
  key: DATA_MODE_KEY,
  initial: { mode: "real" },
  storage,
  parse: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "mode" in parsed &&
      (parsed.mode === "real" || parsed.mode === "simulated")
    ) {
      return { mode: parsed.mode };
    }
    return undefined;
  },
});

export function setDataMode(mode: DataMode): void {
  dataModeStore.setState({ mode });
}

/** The stored choice; "real" until the store has loaded (and when nothing is stored). */
export function useDataMode(): DataMode {
  useEffect(() => {
    void dataModeStore.hydrate();
  }, []);
  return dataModeStore.useStore((s) => s.mode);
}

/** A purchase from the demo world: the notification simulator or the demo seed. */
export function isSimulatedCapture(
  capture: Pick<RecentCapture, "source" | "occurredAt" | "createdAt">
): boolean {
  if (capture.source === SIMULATOR_SOURCE) return true;
  return Date.parse(capture.createdAt) === Date.parse(capture.occurredAt);
}

/** The purchases `mode` shows. */
export function visibleCaptures(
  captures: readonly RecentCapture[],
  mode: DataMode
): RecentCapture[] {
  return mode === "simulated" ? [...captures] : captures.filter((c) => !isSimulatedCapture(c));
}

/** `response` with only the purchases `mode` shows (the same object when nothing is hidden). */
export function visibleResponse(
  response: RecentCapturesResponse,
  mode: DataMode
): RecentCapturesResponse {
  const captures = visibleCaptures(response.captures, mode);
  return captures.length === response.captures.length ? response : { ...response, captures };
}
