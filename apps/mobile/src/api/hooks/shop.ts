/**
 * (added 2026-10-14, Business M2/M3) Shop orders and counter-till bills paid through Kassa. The status is the shop's
 * (reported by its signed webhooks to the API); the app polls every 2 s while an order is still open and stops once
 * every shown order is final.
 */
import {
  MerchantBillProposeResponse,
  MerchantBillView,
  ShopOrdersResponse,
  type ShopOrderView,
} from "@kassa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSessionStore } from "@/stores/session";

import { api } from "../client";
import { keys } from "../keys";

export const SHOP_POLL_MS = 2000;

/** Poll while any order is still moving. */
export function shopPollInterval(orders: readonly ShopOrderView[] | undefined): number | false {
  return orders?.some((o) => !o.final) ? SHOP_POLL_MS : false;
}

export function useShopOrders(opts: { enabled?: boolean } = {}) {
  const authed = useSessionStore((s) => s.status) === "authenticated";
  return useQuery({
    queryKey: keys.shopOrders,
    queryFn: ({ signal }) => api.request("/shop-orders", { schema: ShopOrdersResponse, signal }),
    enabled: authed && opts.enabled !== false,
    refetchInterval: (q) => shopPollInterval(q.state.data?.shopOrders),
  });
}

/** The shop order paid by one proposal (order sheet), or null while there is none yet. */
export function useShopOrderOfProposal(proposalId: string, opts: { poll?: boolean } = {}) {
  const authed = useSessionStore((s) => s.status) === "authenticated";
  return useQuery({
    queryKey: keys.shopOrderOfProposal(proposalId),
    queryFn: async ({ signal }) =>
      (
        await api.request(`/shop-orders?proposalId=${encodeURIComponent(proposalId)}&limit=1`, {
          schema: ShopOrdersResponse,
          signal,
        })
      ).shopOrders[0] ?? null,
    enabled: authed && proposalId.length > 0,
    // Keep polling until the shop reports a final status (or, right after approval, until the order appears).
    refetchInterval: (q) => {
      const o = q.state.data;
      if (o) return o.final ? false : SHOP_POLL_MS;
      return opts.poll ? SHOP_POLL_MS : false;
    },
  });
}

/** The till bill as the merchant reports it (amount and items never come from the link). */
export function useMerchantBill(billId: string) {
  const authed = useSessionStore((s) => s.status) === "authenticated";
  return useQuery({
    queryKey: keys.merchantBill(billId),
    queryFn: ({ signal }) =>
      api.request(`/merchant-bills/${encodeURIComponent(billId)}`, {
        schema: MerchantBillView,
        signal,
      }),
    enabled: authed && billId.length > 0,
    staleTime: 0,
  });
}

/** Propose paying the bill; the server fetches it from the till. */
export function useProposeBill(billId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.request(`/merchant-bills/${encodeURIComponent(billId)}/propose`, {
        json: {},
        schema: MerchantBillProposeResponse,
      }),
    onSettled: () =>
      Promise.all(
        [keys.merchantBill(billId), keys.proposalsPending, keys.shopOrders].map((queryKey) =>
          qc.invalidateQueries({ queryKey })
        )
      ),
  });
}
