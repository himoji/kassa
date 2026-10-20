/** GET /capture/recent for the Activity tab: polled every 30 s while the app is in the foreground. */
import { RecentCapturesResponse } from "@kassa/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { api } from "@/api/client";
import { keys } from "@/api/keys";
import { useSessionStore } from "@/stores/session";

import { dataModeStore, visibleResponse } from "./data-mode";
import { notifyNewCaptures } from "./notifier";

export const RECENT_KEY = keys.recentCaptures;
export const POLL_MS = 30_000;

export async function fetchRecent(signal?: AbortSignal): Promise<RecentCapturesResponse> {
  return api.request("/capture/recent", { schema: RecentCapturesResponse, signal });
}

/**
 * `refetchInterval` only runs while the app is focused (the QueryProvider maps AppState to the focus
 * manager and `refetchIntervalInBackground` is off); a resume refetches because the data is stale.
 */
export function useRecentCaptures() {
  const authed = useSessionStore((s) => s.status) === "authenticated";
  const query = useQuery({
    queryKey: RECENT_KEY,
    queryFn: ({ signal }) => fetchRecent(signal),
    enabled: authed,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: "always",
    staleTime: 10_000,
  });
  const { data } = query;
  useEffect(() => {
    if (!data) return;
    // Only what Activity shows (Settings → Data shown): a simulated purchase does not notify in Real mode.
    void dataModeStore
      .hydrate()
      .then(() => notifyNewCaptures(visibleResponse(data, dataModeStore.getState().mode)))
      .catch(() => {});
  }, [data]);
  return query;
}
