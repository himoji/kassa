/**
 * KassaLite Activity's range picker: which purchases the list shows, by when they happened (GET /capture/recent
 * `from`). Ranges start at local midnight; "all" has no start and is capped by RANGE_LIMIT.
 */
import { RecentCapturesResponse } from "@kassa/shared";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/api/client";
import { keys } from "@/api/keys";
import { useSessionStore } from "@/stores/session";

export const ACTIVITY_RANGES = ["week", "month", "year", "all"] as const;
export type ActivityRange = (typeof ACTIVITY_RANGES)[number];

/** The server's most per call. */
export const RANGE_LIMIT = 1000;

/** First instant of `range` in local time: the last 7 days, this calendar month or year; null for "all". */
export function rangeStart(range: ActivityRange, now: Date = new Date()): Date | null {
  switch (range) {
    case "week":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    case "month":
      return new Date(now.getFullYear(), now.getMonth(), 1);
    case "year":
      return new Date(now.getFullYear(), 0, 1);
    case "all":
      return null;
  }
}

/** Under the recent-captures key, so every invalidation of it (pulls, imports, the live feed) covers ranges too. */
export function useActivityRange(range: ActivityRange) {
  const authed = useSessionStore((s) => s.status) === "authenticated";
  return useQuery({
    queryKey: [...keys.recentCaptures, "range", range],
    queryFn: ({ signal }) => {
      const start = rangeStart(range);
      const from = start ? `&from=${encodeURIComponent(start.toISOString())}` : "";
      return api.request(`/capture/recent?limit=${RANGE_LIMIT}${from}`, {
        schema: RecentCapturesResponse,
        signal,
      });
    },
    enabled: authed,
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
  });
}
