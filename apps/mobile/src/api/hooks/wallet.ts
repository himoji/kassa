import {
  ConvertRequest,
  PayPayeeRequest,
  PayPayeeResponse,
  TopUpRequest,
  TopUpResponse,
  WalletResponse,
} from "@kassa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSessionStore } from "@/stores/session";

import { api } from "../client";
import { keys, moneyKeys } from "../keys";

/** GET /wallet: the user's Kassa ID and whether test top-ups are possible here. */
export function useWallet() {
  const authed = useSessionStore((s) => s.status) === "authenticated";
  return useQuery({
    queryKey: keys.wallet,
    queryFn: ({ signal }) => api.request("/wallet", { schema: WalletResponse, signal }),
    enabled: authed,
  });
}

/** POST /wallet/top-ups: test money in (Stripe test mode or simulated; never real money). */
export function useTopUp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TopUpRequest) =>
      api.request("/wallet/top-ups", { json: TopUpRequest.parse(body), schema: TopUpResponse }),
    onSettled: () => Promise.all(moneyKeys.map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

/** POST /payees/:id/pay: proposes a payment to a saved payee; approval happens on the order sheet. */
export function usePayPayee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ payeeId, ...body }: PayPayeeRequest & { payeeId: string }) =>
      api.request(`/payees/${encodeURIComponent(payeeId)}/pay`, {
        json: PayPayeeRequest.parse(body),
        schema: PayPayeeResponse,
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.proposalsPending }),
  });
}

/**
 * POST /conversions: proposes an exchange between the user's own balances (a CONVERT order, always ASK). The order
 * sheet signs it with the passkey; approving it refreshes the balances (useApproveOrder).
 */
export function useConvert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ConvertRequest) =>
      api.request("/conversions", { json: ConvertRequest.parse(body), schema: PayPayeeResponse }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.proposalsPending }),
  });
}
