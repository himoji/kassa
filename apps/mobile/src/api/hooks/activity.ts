import { CaptureEventRequest, LedgerResponse, NotificationsResponse } from "@kassa/shared";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSessionStore } from "@/stores/session";

import { api } from "../client";
import { keys } from "../keys";

export function useLedger() {
  const authed = useSessionStore((s) => s.status) === "authenticated";
  return useInfiniteQuery({
    queryKey: keys.ledger,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.request(pageParam ? `/ledger?cursor=${encodeURIComponent(pageParam)}` : "/ledger", {
        schema: LedgerResponse,
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor,
    enabled: authed,
  });
}

export function useNotifications() {
  const authed = useSessionStore((s) => s.status) === "authenticated";
  return useQuery({
    queryKey: keys.notifications,
    queryFn: ({ signal }) =>
      api.request("/notifications", { schema: NotificationsResponse, signal }),
    enabled: authed,
    refetchInterval: 20_000,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.request(`/notifications/${encodeURIComponent(id)}/read`, { json: {} }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.notifications }),
  });
}

/** POST /capture/event - triggers only log or draft (I6); never approves anything. */
export function useCaptureEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CaptureEventRequest) =>
      api.request("/capture/event", { json: CaptureEventRequest.parse(body) }),
    onSettled: () =>
      Promise.all(
        [keys.transactions, keys.budgets, keys.notifications, keys.ledger].map((queryKey) =>
          qc.invalidateQueries({ queryKey })
        )
      ),
  });
}
