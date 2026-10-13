import {
  BalancesResponse,
  BudgetsResponse,
  BudgetsSetResponse,
  type BudgetsSetRequest,
  CardFeesResponse,
  CardsResponse,
  ForecastResponse,
  ObligationsResponse,
  ProposalsResponse,
  SetTransactionCategoryRequest,
  TransactionsResponse,
} from "@kassa/shared";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSessionStore } from "@/stores/session";

import { api } from "../client";
import { keys } from "../keys";
import { withPasskeyGate } from "../passkey-gate";

function useAuthed() {
  return useSessionStore((s) => s.status) === "authenticated";
}

export function useBalances() {
  return useQuery({
    queryKey: keys.balances,
    queryFn: ({ signal }) => api.request("/balances", { schema: BalancesResponse, signal }),
    enabled: useAuthed(),
  });
}

export function useBudgets() {
  return useQuery({
    queryKey: keys.budgets,
    queryFn: ({ signal }) => api.request("/budgets", { schema: BudgetsResponse, signal }),
    enabled: useAuthed(),
  });
}

export function useObligations() {
  return useQuery({
    queryKey: keys.obligations,
    queryFn: ({ signal }) => api.request("/obligations", { schema: ObligationsResponse, signal }),
    enabled: useAuthed(),
  });
}

export function useForecast() {
  return useQuery({
    queryKey: keys.forecast,
    queryFn: ({ signal }) => api.request("/forecast", { schema: ForecastResponse, signal }),
    enabled: useAuthed(),
  });
}

export function useCards() {
  return useQuery({
    queryKey: keys.cards,
    queryFn: ({ signal }) => api.request("/cards", { schema: CardsResponse, signal }),
    enabled: useAuthed(),
  });
}

export function useCardFees() {
  return useQuery({
    queryKey: keys.cardFees,
    queryFn: ({ signal }) => api.request("/cards/fees", { schema: CardFeesResponse, signal }),
    enabled: useAuthed(),
  });
}

export function usePendingProposals() {
  return useQuery({
    queryKey: keys.proposalsPending,
    queryFn: ({ signal }) =>
      api.request("/proposals?status=PENDING_APPROVAL", { schema: ProposalsResponse, signal }),
    enabled: useAuthed(),
  });
}

export function useTransactions() {
  return useInfiniteQuery({
    queryKey: keys.transactions,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.request(
        pageParam ? `/transactions?cursor=${encodeURIComponent(pageParam)}` : "/transactions",
        { schema: TransactionsResponse, signal }
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled: useAuthed(),
  });
}

export function useSetCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, category }: { id: string } & SetTransactionCategoryRequest) =>
      api.request(`/transactions/${encodeURIComponent(id)}/category`, { json: { category } }),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.transactions }),
        qc.invalidateQueries({ queryKey: keys.budgets }),
      ]),
  });
}

/**
 * PUT /budgets: this month's limits. New or lower limits apply at once; raising one loosens the rules, so the
 * server answers 428 and the passkey signs it (withPasskeyGate); raises then wait 24 hours (`pending`).
 */
export function useSetBudgets() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (budgets: BudgetsSetRequest["budgets"]) =>
      withPasskeyGate((proof) =>
        api.request("/budgets", {
          method: "PUT",
          json: { budgets, ...proof },
          schema: BudgetsSetResponse,
        })
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.budgets }),
  });
}
