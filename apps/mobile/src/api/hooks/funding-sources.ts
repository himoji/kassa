/** Linked cards and bank accounts (Settings > Linked accounts, the Send screen's "From" picker). */
import {
  FundingSourceDto,
  FundingSourcesResponse,
  SendQuoteResponse,
  StartLinkResponse,
  type LinkBankRequest,
  type LinkCardRequest,
} from "@kassa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSessionStore } from "@/stores/session";

import { api } from "../client";
import { keys } from "../keys";
import { withPasskeyGate } from "../passkey-gate";

export function useFundingSources() {
  const authed = useSessionStore((s) => s.status) === "authenticated";
  return useQuery({
    queryKey: keys.fundingSources,
    queryFn: ({ signal }) =>
      api.request("/funding-sources", { schema: FundingSourcesResponse, signal }),
    enabled: authed,
  });
}

/** Step 1 of linking: a PENDING card or bank (a bank also gets a one-tenge code, simulated). */
export function useStartLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      req: { kind: "card"; body: LinkCardRequest } | { kind: "bank"; body: LinkBankRequest }
    ) =>
      api.request(`/funding-sources/${req.kind}/start`, {
        json: req.body,
        schema: StartLinkResponse,
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.fundingSources }),
  });
}

/** Step 2: the passkey (428 round trip) plus, for a bank, the code. */
export function useConfirmLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, code }: { id: string; code?: string }) =>
      withPasskeyGate((proof) =>
        api.request(`/funding-sources/${encodeURIComponent(id)}/confirm`, {
          json: { ...proof, ...(code ? { code } : {}) },
          schema: FundingSourceDto,
        })
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.fundingSources }),
  });
}

export function useRemoveFundingSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.request(`/funding-sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.fundingSources }),
  });
}

/** The live quote under the amount: what this send would debit, from the wallet or a linked account. */
export function useSendQuote(
  payeeId: string | null,
  amountMinor: number | null,
  sourceId: string | null
) {
  const authed = useSessionStore((s) => s.status) === "authenticated";
  return useQuery({
    queryKey: keys.sendQuote(payeeId ?? "", amountMinor ?? 0, sourceId),
    queryFn: ({ signal }) => {
      const q = new URLSearchParams({ payeeId: payeeId!, amountMinor: String(amountMinor) });
      if (sourceId) q.set("fundingSourceId", sourceId);
      return api.request(`/send/quote?${q.toString()}`, { schema: SendQuoteResponse, signal });
    },
    enabled: authed && Boolean(payeeId) && Boolean(amountMinor),
    staleTime: 15_000,
    retry: false,
  });
}
