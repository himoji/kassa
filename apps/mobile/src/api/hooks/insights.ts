import { SpendingInsightsResponse, TransactionDetailResponse } from "@kassa/shared";
import { useQuery } from "@tanstack/react-query";

import { useSessionStore } from "@/stores/session";

import { api } from "../client";
import { keys } from "../keys";

function useAuthed() {
  return useSessionStore((s) => s.status) === "authenticated";
}

/** GET /insights/spending: this month by category and day, against last month and a usual month. */
export function useSpendingInsights() {
  return useQuery({
    queryKey: keys.insights,
    queryFn: ({ signal }) =>
      api.request("/insights/spending", { schema: SpendingInsightsResponse, signal }),
    enabled: useAuthed(),
    staleTime: 30_000,
  });
}

/** GET /transactions/:id: one purchase with its place, card, category month and merchant history. */
export function useTransactionDetail(id: string) {
  return useQuery({
    queryKey: keys.transaction(id),
    queryFn: ({ signal }) =>
      api.request(`/transactions/${encodeURIComponent(id)}`, {
        schema: TransactionDetailResponse,
        signal,
      }),
    enabled: useAuthed() && id.length > 0,
  });
}
